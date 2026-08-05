// Package term owns this agent's pseudo-terminals: what a pane attaches to
// (target.go), the PTY itself (pty.go) and the relay of its output back to the
// browser (this file).
//
// TWO GUARDS AGAINST A RUNAWAY PRODUCER, both learned the hard way from
// browser-facing terminals:
//   - COALESCE. A `yes` loop or a big build emits thousands of tiny writes per
//     second; one frame each would spend the whole socket on framing overhead.
//     Output is buffered and flushed on a short interval instead — but the FIRST
//     chunk after a quiet moment goes out immediately, because on a terminal with
//     no local echo that chunk is usually the character somebody just typed. See
//     `pump`.
//   - CAP WHAT IS IN FLIGHT. If the producer outruns the socket, the buffer is
//     the thing that grows without bound. Past the cap the OLDEST bytes go (a
//     terminal's value is in its most recent output) and the drop is announced in
//     the stream, because silently losing output is how people debug the wrong
//     problem for an hour.
//
// Ported from apps/agent/src/term/{manager,pty,target}.ts. The one deliberate
// divergence is the PTY: there was a native mode and a script(1) fallback, and
// there is now a single real PTY — see Spawn.
package term

import (
	"bytes"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/podosoft-dev/pdmux/agent/internal/log"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/sample"
)

// Relay tuning. FlushInterval and MaxPendingBytes are defaults the server can
// override; MaxFrameBytes and MaxTerminals are the agent's own limits.
const (
	FlushInterval   = 20 * time.Millisecond
	MaxPendingBytes = 256 << 10
	MaxFrameBytes   = 64 << 10

	// MaxTerminals is how many PTYs one agent will hold open.
	//
	// It is a guard on the HOST, not on the browser: every pane is a shell plus
	// whatever it started, and a layout that auto-attached to every session on a
	// host used to open panes until the machine complained (measured on a real
	// fleet: `s15`-`s17` refused, 43 times in a day). Sixteen is well past any
	// grid a person reads and far short of what hurts. Refusing loudly — an
	// `error` frame the pane prints — is what turned that into a legible message
	// instead of terminals that never started.
	MaxTerminals = 16

	// maxErrorMessage bounds what is echoed back to a browser.
	maxErrorMessage = 512

	// SlowLockWait is when a pane's queue for sendMu is worth a line.
	//
	// Healthy is microseconds: the lock is held for one socket write, which on the
	// deployment this was reported from takes about 1ms over a 0.05ms RTT link. A
	// pane that waited 100ms did not wait for its own frame — it waited for
	// somebody else's, and that is the thing worth knowing. Kept well below
	// net.SlowWriteThreshold so a slow write shows up as BOTH a slow write and the
	// queue it caused; seeing only one of the two would leave the direction of
	// cause ambiguous, which is what made this hard to pin down before.
	SlowLockWait = 100 * time.Millisecond
)

// Options configure a Manager. Every dependency is injectable so a spec can
// drive the relay without a real shell.
type Options struct {
	// Send delivers one frame to the server. The Manager serialises its calls.
	Send   func(frame protocol.TerminalServerFrame)
	Logger *log.Logger
	// Spawn starts a PTY; nil uses the real one.
	Spawn func(spec Spec) (Process, error)
	// Which looks a binary up on the host; nil uses the real one.
	Which           func(string) (string, bool)
	FlushInterval   time.Duration
	MaxPendingBytes int
	MaxTerminals    int
}

// Manager keeps every terminal this agent has open.
type Manager struct {
	send   func(frame protocol.TerminalServerFrame)
	logger *log.Logger
	spawn  func(spec Spec) (Process, error)
	// which answers "is this binary on the host?" — injected so a spec can state
	// the absent case without depending on what is installed where it runs.
	which func(string) (string, bool)

	flushInterval time.Duration
	maxTerminals  int

	// sendMu serialises frames. The Node original was single-threaded; here every
	// pane has its own goroutine, and a websocket writer is not safe for
	// concurrent use — two panes flushing at once would interleave halves of two
	// frames on the wire.
	sendMu sync.Mutex

	// lockWaits times how long each pane queued for sendMu. Drained by the agent
	// on the same timer as the socket's write stats, so the two can be read
	// against each other: a long wait with fast writes means a producer other than
	// the socket held the wire.
	lockWaits *sample.Set

	// opened counts every pane this manager has started since the process began.
	//
	// ⚠ IT IS CUMULATIVE ON PURPOSE, and it is here to be read against the live
	// count and the goroutine count. A leak on the close path is invisible in
	// "panes open now" — that number is correct — and only shows as the gap
	// between how many were ever started and what the process is still holding.
	opened atomic.Int64

	mu              sync.Mutex
	terminals       map[string]*terminal
	opening         map[string]struct{}
	maxPendingBytes int
}

// terminal is one open pane.
//
// The buffer fields are touched only by that pane's own pump goroutine, so they
// need no lock; everything reachable from another goroutine is behind
// Manager.mu.
type terminal struct {
	pty Process
	// kind is what this pane attached to, remembered for Counts.
	//
	// ⚠ IT IS KEPT FOR THE UPDATE PATH, which is the one caller that has to tell
	// the two apart: a restart ends every `shell` pane and the children it
	// started, while a `session` pane loses only its viewer. Without it the
	// dashboard can only warn "terminals are attached", which is the same
	// sentence for "you will lose an in-progress build" and "nothing will
	// happen".
	kind protocol.TerminalKind

	buffer  [][]byte
	pending int
	dropped int
}

// NewManager builds a Manager.
func NewManager(options Options) *Manager {
	m := &Manager{
		send:            options.Send,
		logger:          options.Logger,
		spawn:           options.Spawn,
		which:           options.Which,
		flushInterval:   options.FlushInterval,
		maxTerminals:    options.MaxTerminals,
		terminals:       make(map[string]*terminal),
		opening:         make(map[string]struct{}),
		maxPendingBytes: options.MaxPendingBytes,
		lockWaits:       sample.New(0),
	}
	if m.spawn == nil {
		m.spawn = Spawn
	}
	if m.logger == nil {
		m.logger = log.Silent()
	}
	if m.flushInterval <= 0 {
		m.flushInterval = FlushInterval
	}
	if m.maxPendingBytes <= 0 {
		m.maxPendingBytes = MaxPendingBytes
	}
	if m.maxTerminals <= 0 {
		m.maxTerminals = MaxTerminals
	}
	return m
}

// OpenedTotal is how many panes have been started since this process began.
func (m *Manager) OpenedTotal() int64 { return m.opened.Load() }

// DrainLockWaitStats returns how long panes have been queueing for the send lock
// since the last call, and starts a fresh interval.
func (m *Manager) DrainLockWaitStats() sample.Summary { return m.lockWaits.Drain() }

// Count is how many terminals are open.
func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.terminals)
}

// Counts is how many open panes are of each kind.
//
// THE SPLIT IS THE POINT, NOT THE TOTAL. It is what a remote update sends with
// `accepted` so the person pressing the button reads the cost in numbers: the
// shell panes and everything running inside them end with the restart, the
// session panes re-attach to work that kept running.
//
// Anything that is not `shell` counts as a session, which is the branch
// ResolveTarget itself takes — so a pane counted as surviving is one that
// actually does, including a target whose kind arrived unset and was therefore
// opened as a session.
func (m *Manager) Counts() (shell, session int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, t := range m.terminals {
		if t.kind == protocol.TerminalShell {
			shell++
			continue
		}
		session++
	}
	return shell, session
}

// BufferBytes is the per-pane cap in force right now.
func (m *Manager) BufferBytes() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.maxPendingBytes
}

// SetBufferBytes adopts a new buffer cap from the server's config, live. It
// applies to panes that are already open, so raising it does not require
// reopening a terminal that is dropping output right now — which is exactly when
// it gets raised.
func (m *Manager) SetBufferBytes(bytes int) {
	if bytes <= 0 {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.maxPendingBytes = bytes
}

// Handle applies one browser frame.
//
// It is synchronous, where the TypeScript's open was async: spawning a PTY is a
// fork and an ioctl, and doing it inline means an `input` that follows an `open`
// on the same socket can no longer arrive while the terminal is still a promise.
func (m *Manager) Handle(frame protocol.TerminalClientFrame) {
	switch f := frame.(type) {
	case *protocol.TerminalOpen:
		m.open(f.TermID, f.Target)
	case *protocol.TerminalInput:
		if t := m.lookup(f.TermID); t != nil {
			if err := t.pty.Write(f.Data); err != nil {
				// A write to a pty whose child just died is the ordinary shape of a
				// race with `exit`, not something to tell the browser about.
				m.logger.Debug("Terminal write failed", log.F("termId", f.TermID), log.F("error", err.Error()))
			}
		}
	case *protocol.TerminalResize:
		if t := m.lookup(f.TermID); t != nil {
			if err := t.pty.Resize(f.Cols, f.Rows); err != nil {
				m.logger.Debug("Terminal resize failed", log.F("termId", f.TermID), log.F("error", err.Error()))
			}
		}
	case *protocol.TerminalClose:
		m.Close(f.TermID)
	}
}

func (m *Manager) lookup(termID string) *terminal {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.terminals[termID]
}

func (m *Manager) open(termID string, target protocol.TerminalTarget) {
	m.mu.Lock()
	_, live := m.terminals[termID]
	_, starting := m.opening[termID]
	if live || starting {
		m.mu.Unlock()
		// A duplicate open is a reconnect that raced the old socket's teardown.
		m.logger.Debug("Ignoring duplicate terminal open", log.F("termId", termID))
		return
	}
	if len(m.terminals) >= m.maxTerminals {
		limit := m.maxTerminals
		m.mu.Unlock()
		m.fail(termID, fmt.Sprintf("terminal limit reached (%d)", limit))
		return
	}
	m.opening[termID] = struct{}{}
	m.mu.Unlock()

	defer func() {
		m.mu.Lock()
		delete(m.opening, termID)
		m.mu.Unlock()
	}()

	resolved, err := ResolveTarget(target, nil)
	if err != nil {
		m.fail(termID, err.Error())
		return
	}
	// Asked before spawning rather than after, so what the browser gets is one
	// sentence we chose instead of however the OS phrased the exec failure.
	if target.Kind != protocol.TerminalShell && !MultiplexerAvailable(m.which) {
		m.fail(termID, MissingMultiplexerMessage)
		return
	}
	process, err := m.spawn(Spec{
		File: resolved.File,
		Args: resolved.Args,
		Cols: target.Cols,
		Rows: target.Rows,
	})
	if err != nil {
		m.fail(termID, fmt.Sprintf("failed to open terminal: %v", err))
		return
	}

	t := &terminal{pty: process, kind: target.Kind}
	m.mu.Lock()
	m.terminals[termID] = t
	m.mu.Unlock()

	m.opened.Add(1)
	go m.pump(termID, t)
	m.logger.Info("Opened terminal", log.F("termId", termID), log.F("target", resolved.Label))
	m.emit(&protocol.TerminalReady{Type: protocol.TermReady, TermID: termID, Pid: process.Pid()})
}

// Close tears one pane down. The pty's own exit still produces an `exit` frame,
// so a browser that closed a pane and a browser whose shell exited on its own
// see the same ending.
func (m *Manager) Close(termID string) {
	m.mu.Lock()
	t, ok := m.terminals[termID]
	if !ok {
		m.mu.Unlock()
		return
	}
	delete(m.terminals, termID)
	m.mu.Unlock()
	t.pty.Kill()
}

// CloseAll is called when the socket drops. Every pty goes with it — a `session`
// terminal loses only its viewer (the multiplexer session keeps running), which
// is exactly why `session` is the default kind.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	doomed := make([]*terminal, 0, len(m.terminals))
	for termID, t := range m.terminals {
		doomed = append(doomed, t)
		delete(m.terminals, termID)
	}
	m.mu.Unlock()
	for _, t := range doomed {
		t.pty.Kill()
	}
}

// pump owns one terminal's buffer for its whole life: it is the only goroutine
// that touches the pane's bytes, which is what keeps the hot path lock-free.
func (m *Manager) pump(termID string, t *terminal) {
	output := t.pty.Output()
	exit := t.pty.Exit()

	// A one-shot timer armed by the first byte after an idle moment.
	//
	// ⚠ LEADING EDGE: THE FIRST CHUNK GOES OUT BEFORE THE TIMER, NOT AFTER IT. The
	// comment that used to stand here claimed the window starting with the output
	// meant "a single keystroke echo is not held for a full interval" — and had it
	// exactly backwards. Arming the window on the first byte and flushing at its end
	// IS holding that byte for the full interval, so every echoed character paid the
	// whole 20 ms.
	//
	// That is not a rounding error on this path, because a remote terminal has NO
	// LOCAL ECHO: the character a person just typed appears only after it has crossed
	// to the host and come back. Measured on this deployment, that round trip is
	// ~55 ms — the same as ssh to the same machine — so 20 ms was a third of the
	// budget, spent buffering one byte that had nothing to coalesce with.
	//
	// Coalescing keeps doing its job, because its job is about the SECOND byte
	// onward: a `yes` loop or a build still collapses into one frame per interval
	// rather than thousands. What changes is that a quiet pane answers at once.
	var timer *time.Timer
	var tick <-chan time.Time
	stopTimer := func() {
		if timer != nil {
			timer.Stop()
			timer, tick = nil, nil
		}
	}

	for {
		select {
		case chunk, ok := <-output:
			if !ok {
				// Closed: the child is gone and `exit` is next. Disable this case so
				// the loop does not spin on a closed channel.
				output = nil
				continue
			}
			t.push(chunk, m.BufferBytes())
			if tick == nil {
				// Nothing was pending, so this chunk is the start of a burst — or it is
				// the whole of it, which is what an echoed keystroke looks like. Send it
				// now and let the window cover whatever follows.
				m.flush(termID, t)
				timer = time.NewTimer(m.flushInterval)
				tick = timer.C
			}
		case <-tick:
			timer, tick = nil, nil
			m.flush(termID, t)
		case code := <-exit:
			stopTimer()
			// Output is closed before Exit delivers (see Process), so whatever is
			// still queued is all there will ever be — and it is the tail of the
			// session, which is the part somebody is reading.
			if output != nil {
				for chunk := range output {
					t.push(chunk, m.BufferBytes())
				}
			}
			m.flush(termID, t)
			m.forget(termID, t)
			m.emit(&protocol.TerminalExit{Type: protocol.TermExit, TermID: termID, Code: code})
			return
		}
	}
}

// forget drops the pane from the registry, but only if it is still the one this
// pump owns: a reconnect can reopen the same termId before a killed pty has
// finished dying, and deleting blind would evict the live replacement.
func (m *Manager) forget(termID string, t *terminal) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if current, ok := m.terminals[termID]; ok && current == t {
		delete(m.terminals, termID)
	}
}

// push appends a chunk and drops the oldest bytes past the cap.
func (t *terminal) push(chunk []byte, maxPending int) {
	t.buffer = append(t.buffer, chunk)
	t.pending += len(chunk)
	// The newest chunk is never dropped: a pane that is over its cap must still
	// show what just happened.
	for t.pending > maxPending && len(t.buffer) > 1 {
		oldest := t.buffer[0]
		t.buffer = t.buffer[1:]
		t.pending -= len(oldest)
		t.dropped += len(oldest)
	}
}

func (m *Manager) flush(termID string, t *terminal) {
	if len(t.buffer) == 0 && t.dropped == 0 {
		return
	}
	data := bytes.Join(t.buffer, nil)
	t.buffer, t.pending = nil, 0
	// The loss is reported in its own field rather than injected into the stream:
	// a marker inside `data` lands in the middle of whatever escape sequence was
	// in flight, so the honest report corrupted the pane it was being honest
	// about.
	dropped := t.dropped
	t.dropped = 0
	if dropped > 0 {
		// Dropping whole chunks can leave the continuation bytes of a rune whose
		// start byte went with them. They decode to nothing; sending them only adds
		// a replacement character to a pane that already knows it lost data.
		data = trimOrphanBytes(data)
	}

	for offset := 0; offset < len(data); {
		end := frameEnd(data, offset)
		m.emit(&protocol.TerminalOutput{
			Type:    protocol.TermOutput,
			TermID:  termID,
			Data:    string(data[offset:end]),
			Dropped: dropped,
		})
		dropped = 0 // Counted once, on the first frame of this flush.
		offset = end
	}
	if len(data) == 0 && dropped > 0 {
		m.emit(&protocol.TerminalOutput{Type: protocol.TermOutput, TermID: termID, Dropped: dropped})
	}
}

func (m *Manager) fail(termID string, message string) {
	m.logger.Warn("Refused terminal open", log.F("termId", termID), log.F("reason", message))
	m.emit(&protocol.TerminalError{
		Type:    protocol.TermError,
		TermID:  termID,
		Message: truncate(message, maxErrorMessage),
	})
}

func (m *Manager) emit(frame protocol.TerminalServerFrame) {
	if m.send == nil {
		return
	}
	waited := m.sendLocked(frame)
	m.lockWaits.Add(waited)
	// ⚠ LOGGED AFTER THE UNLOCK, NEVER INSIDE IT. The logger takes a mutex of its
	// own and writes to stderr; holding sendMu across that would make every pane on
	// this host wait on journald, which is the very stall this line exists to
	// report. Reporting a problem must not be able to cause it.
	if waited >= SlowLockWait {
		m.logger.Warn("Terminal frame waited for the send lock",
			log.F("waitMs", waited.Milliseconds()))
	}
}

// sendLocked holds sendMu for exactly one frame and reports how long the caller
// queued for it.
//
// ⚠ THE WAIT IS THE INTERESTING NUMBER, NOT THE SEND. sendMu is one lock for
// EVERY pane on this host, and behind it sits a socket shared with the heartbeat,
// the git pass, file reads and exec results. So a long wait here is the fingerprint
// of "one producer held the wire and every terminal on this host froze together" —
// reported repeatedly as slowness that ssh to the same machine did not show, and
// until now not measured anywhere.
func (m *Manager) sendLocked(frame protocol.TerminalServerFrame) time.Duration {
	requested := time.Now()
	m.sendMu.Lock()
	// Deferred rather than unlocked inline so a panic in send cannot leave every
	// pane on this host deadlocked on a mutex nobody will ever release.
	defer m.sendMu.Unlock()
	waited := time.Since(requested)
	m.send(frame)
	return waited
}

// frameEnd is where the next output frame stops: at most MaxFrameBytes, and
// never inside a UTF-8 sequence. Cutting one in half would put an invalid byte
// in a JSON string, and the encoder replaces it with U+FFFD — permanently
// corrupting the pane at every 64 KiB boundary of a large paste.
func frameEnd(data []byte, offset int) int {
	end := offset + MaxFrameBytes
	if end >= len(data) {
		return len(data)
	}
	// A sequence is at most 4 bytes, so backing off 3 always finds the boundary.
	for back := 0; back < 3 && end > offset+1; back++ {
		if utf8.RuneStart(data[end]) {
			return end
		}
		end--
	}
	return end
}

// trimOrphanBytes removes leading continuation bytes left behind by a drop.
func trimOrphanBytes(data []byte) []byte {
	cut := 0
	for cut < len(data) && cut < 3 && !utf8.RuneStart(data[cut]) {
		cut++
	}
	return data[cut:]
}

// truncate cuts a string to max BYTES without splitting a rune — the same reason
// frames respect rune boundaries, applied to the error text a browser prints.
func truncate(value string, max int) string {
	if len(value) <= max {
		return value
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}
	return value[:cut]
}
