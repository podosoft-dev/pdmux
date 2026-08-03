package term

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// muxInstalled is the lookup these specs run with.
//
// ⚠ INJECTED RATHER THAN INHERITED. Every spec below is about relaying bytes, not
// about what is installed where the spec happens to run — and the manager now
// refuses a `session` open on a host with no multiplexer. Reading the real host
// would make this file pass or fail on whether the machine has tmux, which is a
// fact none of these tests are about.
func muxInstalled(string) (string, bool) { return "/usr/bin/tmux", true }

// fakePty is a pty a spec drives by hand — no shell, no /dev/pts, no cleanup.
// It honours the ordering contract Process states (Output closes before Exit
// delivers), because the relay's exit path depends on it.
type fakePty struct {
	mu      sync.Mutex
	written []string
	resizes [][2]int
	killed  bool

	output chan []byte
	exit   chan *int
	once   sync.Once
}

func newFakePty() *fakePty {
	return &fakePty{output: make(chan []byte, 256), exit: make(chan *int, 1)}
}

func (f *fakePty) Pid() *int { pid := 4242; return &pid }

func (f *fakePty) Write(data string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.written = append(f.written, data)
	return nil
}

func (f *fakePty) Resize(cols, rows int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.resizes = append(f.resizes, [2]int{cols, rows})
	return nil
}

// Kill ends the process, as a real one does: the relay's own bookkeeping must
// not depend on a fake that stays alive after being killed.
func (f *fakePty) Kill() {
	f.mu.Lock()
	f.killed = true
	f.mu.Unlock()
	f.die(nil)
}

func (f *fakePty) Output() <-chan []byte { return f.output }
func (f *fakePty) Exit() <-chan *int     { return f.exit }

func (f *fakePty) emit(chunk string) { f.output <- []byte(chunk) }

func (f *fakePty) die(code *int) {
	f.once.Do(func() {
		close(f.output)
		f.exit <- code
		close(f.exit)
	})
}

func (f *fakePty) state() (written []string, resizes [][2]int, killed bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.written...), append([][2]int(nil), f.resizes...), f.killed
}

type harness struct {
	manager *Manager
	pty     *fakePty

	mu     sync.Mutex
	frames []protocol.TerminalServerFrame
}

func (h *harness) sent() []protocol.TerminalServerFrame {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]protocol.TerminalServerFrame(nil), h.frames...)
}

func (h *harness) forget() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.frames = nil
}

func (h *harness) outputs() []*protocol.TerminalOutput {
	var out []*protocol.TerminalOutput
	for _, frame := range h.sent() {
		if output, ok := frame.(*protocol.TerminalOutput); ok {
			out = append(out, output)
		}
	}
	return out
}

func (h *harness) hasOutput() bool { return len(h.outputs()) > 0 }

// openManager opens one terminal backed by a fake pty.
func openManager(t *testing.T, maxPendingBytes int, flushInterval time.Duration) *harness {
	t.Helper()
	h := &harness{pty: newFakePty()}
	h.manager = NewManager(Options{
		Which: muxInstalled,
		Send: func(frame protocol.TerminalServerFrame) {
			h.mu.Lock()
			h.frames = append(h.frames, frame)
			h.mu.Unlock()
		},
		Spawn:           func(Spec) (Process, error) { return h.pty, nil },
		FlushInterval:   flushInterval,
		MaxPendingBytes: maxPendingBytes,
	})
	name := "main"
	h.manager.Handle(&protocol.TerminalOpen{
		Type:   protocol.TermOpen,
		TermID: "t1",
		Target: sessionTarget(&name),
	})
	t.Cleanup(func() { h.pty.die(nil) })
	return h
}

func TestManagerOutput(t *testing.T) {
	t.Run("[TC-PDTERM-024] coalesces a burst of writes into one output frame", func(t *testing.T) {
		h := openManager(t, MaxPendingBytes, 50*time.Millisecond)
		ready, ok := h.sent()[0].(*protocol.TerminalReady)
		if !ok || ready.TermID != "t1" || ready.Pid == nil || *ready.Pid != 4242 {
			t.Fatalf("first frame = %#v, want ready", h.sent()[0])
		}
		for i := 0; i < 50; i++ {
			h.pty.emit(fmt.Sprintf("chunk-%d ", i))
		}
		waitFor(t, ptyTimeout, "the flush", h.hasOutput)

		outputs := h.outputs()
		if len(outputs) != 1 {
			t.Fatalf("%d output frames, want one — the burst was not coalesced", len(outputs))
		}
		if !strings.Contains(outputs[0].Data, "chunk-0 ") || !strings.Contains(outputs[0].Data, "chunk-49 ") {
			t.Fatalf("frame lost part of the burst: %q", outputs[0].Data)
		}
		if outputs[0].Dropped != 0 {
			t.Fatalf("dropped = %d on a pane well under its cap", outputs[0].Dropped)
		}
	})

	t.Run("[TC-PDTERM-025] caps what is in flight and reports the loss out of band", func(t *testing.T) {
		h := openManager(t, 64, 10*time.Millisecond)
		for i := 0; i < 10; i++ {
			h.pty.emit(strings.Repeat("x", 50))
		}
		waitFor(t, ptyTimeout, "the flush", h.hasOutput)

		total := 0
		for _, output := range h.outputs() {
			total += output.Dropped
			// The count travels in its own field — a marker inside `data` would land
			// in the middle of an escape sequence and corrupt the pane it was
			// reporting on.
			if strings.Trim(output.Data, "x") != "" {
				t.Fatalf("something was injected into the stream: %q", output.Data)
			}
		}
		if total == 0 {
			t.Fatal("500 bytes through a 64 byte cap dropped nothing")
		}
	})

	t.Run("[TC-PDTERM-027] counts the loss once per flush, and a quiet pane reports zero", func(t *testing.T) {
		h := openManager(t, 64, 10*time.Millisecond)
		for i := 0; i < 10; i++ {
			h.pty.emit(strings.Repeat("y", 50))
		}
		waitFor(t, ptyTimeout, "the flush", h.hasOutput)

		announced := 0
		for _, output := range h.outputs() {
			if output.Dropped > 0 {
				announced++
			}
		}
		if announced != 1 {
			t.Fatalf("%d frames carried a drop count, want exactly one per flush", announced)
		}

		h.forget()
		h.pty.emit("z")
		waitFor(t, ptyTimeout, "the next flush", h.hasOutput)
		if next := h.outputs()[0]; next.Dropped != 0 {
			// Repeating the last count forever would have every later frame claim a
			// loss that already happened.
			t.Fatalf("a quiet pane reported dropped = %d", next.Dropped)
		}
	})

	t.Run("[TC-PDTERM-027] adopts a new buffer cap from the server, live", func(t *testing.T) {
		h := openManager(t, 64, 10*time.Millisecond)
		if got := h.manager.BufferBytes(); got != 64 {
			t.Fatalf("bufferBytes = %d", got)
		}
		h.manager.SetBufferBytes(1 << 20)
		if got := h.manager.BufferBytes(); got != 1<<20 {
			t.Fatalf("bufferBytes after raise = %d", got)
		}
		h.manager.SetBufferBytes(0) // nonsense is ignored, not applied
		if got := h.manager.BufferBytes(); got != 1<<20 {
			t.Fatalf("bufferBytes after a zero = %d", got)
		}
	})

	// Untagged: framing at a byte offset is new. The TypeScript sliced a JS
	// string, so its 64 KiB boundary fell on UTF-16 code units; here it falls on
	// bytes, and a sequence cut in half becomes U+FFFD the moment the frame is
	// JSON encoded.
	t.Run("never splits a UTF-8 sequence across output frames", func(t *testing.T) {
		h := openManager(t, 8<<20, 10*time.Millisecond)
		// 3 bytes per rune, so no multiple of the frame size lands on a boundary.
		burst := strings.Repeat("한", (MaxFrameBytes*2)/3)
		h.pty.emit(burst)
		waitFor(t, ptyTimeout, "the whole burst", func() bool {
			total := 0
			for _, output := range h.outputs() {
				total += len(output.Data)
			}
			return total >= len(burst)
		})

		var rebuilt strings.Builder
		for _, output := range h.outputs() {
			if !utf8.ValidString(output.Data) {
				t.Fatalf("frame of %d bytes is not valid UTF-8", len(output.Data))
			}
			rebuilt.WriteString(output.Data)
		}
		if rebuilt.String() != burst {
			t.Fatalf("stream did not survive framing (%d bytes out of %d)", rebuilt.Len(), len(burst))
		}
	})
}

func TestManagerLifecycle(t *testing.T) {
	t.Run("[TC-PDTERM-026] forwards input and resize, then reports the exit", func(t *testing.T) {
		h := openManager(t, MaxPendingBytes, 10*time.Millisecond)
		h.manager.Handle(&protocol.TerminalInput{Type: protocol.TermInput, TermID: "t1", Data: "ls\n"})
		h.manager.Handle(&protocol.TerminalResize{Type: protocol.TermResize, TermID: "t1", Cols: 120, Rows: 40})

		written, resizes, _ := h.pty.state()
		if len(written) != 1 || written[0] != "ls\n" {
			t.Fatalf("written = %q", written)
		}
		if len(resizes) != 1 || resizes[0] != [2]int{120, 40} {
			t.Fatalf("resizes = %v", resizes)
		}
		// A frame for a terminal that does not exist is ignored, not a panic: the
		// browser can always be one frame behind a pane that just died.
		h.manager.Handle(&protocol.TerminalInput{Type: protocol.TermInput, TermID: "gone", Data: "x"})

		code := 0
		h.pty.die(&code)
		waitFor(t, ptyTimeout, "the exit frame", func() bool {
			frames := h.sent()
			exit, ok := frames[len(frames)-1].(*protocol.TerminalExit)
			return ok && exit.TermID == "t1" && exit.Code != nil && *exit.Code == 0
		})
		if h.manager.Count() != 0 {
			t.Fatalf("count = %d after the child exited", h.manager.Count())
		}
	})

	t.Run("[TC-PDTERM-026] kills every pty when the socket drops", func(t *testing.T) {
		h := openManager(t, MaxPendingBytes, 10*time.Millisecond)
		h.manager.CloseAll()
		if _, _, killed := h.pty.state(); !killed {
			t.Fatal("closeAll left a pty running")
		}
		if h.manager.Count() != 0 {
			t.Fatalf("count = %d after closeAll", h.manager.Count())
		}
	})

	t.Run("[TC-PDTERM-026] flushes what the shell wrote last before the exit frame", func(t *testing.T) {
		h := openManager(t, MaxPendingBytes, time.Hour) // never flushes on the timer
		h.pty.emit("goodbye")
		code := 3
		h.pty.die(&code)
		waitFor(t, ptyTimeout, "the exit frame", func() bool {
			frames := h.sent()
			_, ok := frames[len(frames)-1].(*protocol.TerminalExit)
			return ok
		})
		// The last screen of a session is the part somebody is reading; it must not
		// race the exit frame and lose.
		outputs := h.outputs()
		if len(outputs) == 0 || outputs[0].Data != "goodbye" {
			t.Fatalf("outputs = %v, want the tail flushed before exit", outputs)
		}
	})

	t.Run("[TC-PDTERM-026] answers an unopenable target with an error frame", func(t *testing.T) {
		h := &harness{}
		h.manager = NewManager(Options{
			Which: muxInstalled,
			Send: func(frame protocol.TerminalServerFrame) {
				h.mu.Lock()
				h.frames = append(h.frames, frame)
				h.mu.Unlock()
			},
			Spawn: func(Spec) (Process, error) { return nil, errors.New("no pty available") },
		})
		name := "main"
		h.manager.Handle(&protocol.TerminalOpen{Type: protocol.TermOpen, TermID: "bad", Target: sessionTarget(&name)})

		failure, ok := h.sent()[0].(*protocol.TerminalError)
		if !ok || failure.TermID != "bad" || !strings.Contains(failure.Message, "no pty available") {
			t.Fatalf("first frame = %#v, want an error naming the failure", h.sent()[0])
		}
		if h.manager.Count() != 0 {
			t.Fatalf("a failed open left %d terminals behind", h.manager.Count())
		}
	})

	t.Run("[TC-PDTERM-023][TC-PDTERM-026] answers a refused session name with an error frame", func(t *testing.T) {
		h := &harness{}
		spawned := 0
		h.manager = NewManager(Options{
			Which: muxInstalled,
			Send: func(frame protocol.TerminalServerFrame) {
				h.mu.Lock()
				h.frames = append(h.frames, frame)
				h.mu.Unlock()
			},
			Spawn: func(Spec) (Process, error) { spawned++; return newFakePty(), nil },
		})
		hostile := "a; rm -rf /"
		h.manager.Handle(&protocol.TerminalOpen{Type: protocol.TermOpen, TermID: "bad", Target: sessionTarget(&hostile)})

		failure, ok := h.sent()[0].(*protocol.TerminalError)
		if !ok || !strings.Contains(failure.Message, "invalid session name") {
			t.Fatalf("first frame = %#v, want the refusal", h.sent()[0])
		}
		if spawned != 0 {
			t.Fatal("a refused name still reached a pty")
		}
	})

	t.Run("[TC-PDTERM-026] ignores a duplicate open for a live terminal", func(t *testing.T) {
		h := openManager(t, MaxPendingBytes, 10*time.Millisecond)
		name := "main"
		// A duplicate open is a reconnect that raced the old socket's teardown; the
		// live pane keeps running rather than being replaced by a second pty.
		h.manager.Handle(&protocol.TerminalOpen{Type: protocol.TermOpen, TermID: "t1", Target: sessionTarget(&name)})
		if h.manager.Count() != 1 {
			t.Fatalf("count = %d after a duplicate open", h.manager.Count())
		}
		if len(h.sent()) != 1 {
			t.Fatalf("a duplicate open produced %d frames, want only the first ready", len(h.sent()))
		}
	})
}

// Untagged: remembering a pane's kind is new — it exists so a remote update can
// warn in numbers ("2 shells will be killed, 3 sessions will re-attach") instead
// of the one sentence that covers both cases. No existing TC pins it.
func TestManagerCounts(t *testing.T) {
	t.Run("counts each open pane by what it attached to", func(t *testing.T) {
		var ptys []*fakePty
		manager := NewManager(Options{
			Which: muxInstalled,
			Send:  func(protocol.TerminalServerFrame) {},
			Spawn: func(Spec) (Process, error) {
				p := newFakePty()
				ptys = append(ptys, p)
				return p, nil
			},
		})
		t.Cleanup(func() {
			for _, p := range ptys {
				p.die(nil)
			}
		})

		if shell, session := manager.Counts(); shell != 0 || session != 0 {
			t.Fatalf("an idle manager counts %d/%d panes", shell, session)
		}

		name := "main"
		manager.Handle(&protocol.TerminalOpen{Type: protocol.TermOpen, TermID: "s1", Target: shellTarget()})
		manager.Handle(&protocol.TerminalOpen{Type: protocol.TermOpen, TermID: "m1", Target: sessionTarget(&name)})
		// A target whose kind never arrived is opened as a session by ResolveTarget,
		// so it has to be COUNTED as one: counting it as a shell would warn about
		// work a restart does not actually end.
		manager.Handle(&protocol.TerminalOpen{
			Type:   protocol.TermOpen,
			TermID: "m2",
			Target: protocol.TerminalTarget{Cols: 80, Rows: 24},
		})

		shell, session := manager.Counts()
		if shell != 1 || session != 2 {
			t.Fatalf("counts = %d shell / %d session, want 1/2", shell, session)
		}

		// A closed pane stops counting: the numbers are about what a restart would
		// cost RIGHT NOW, and a stale count is worse than none.
		manager.Close("m1")
		if shell, session := manager.Counts(); shell != 1 || session != 1 {
			t.Fatalf("counts = %d/%d after closing a session pane, want 1/1", shell, session)
		}
		manager.CloseAll()
		if shell, session := manager.Counts(); shell != 0 || session != 0 {
			t.Fatalf("counts = %d/%d after closeAll", shell, session)
		}
	})
}

// Untagged: MAX_TERMINALS predates the port but no TC pinned it — the refusal is
// only documented in docs/OPERATIONS.md, by the exact string a pane prints.
func TestManagerLimit(t *testing.T) {
	t.Run("refuses to open more terminals than the host guard allows", func(t *testing.T) {
		var mu sync.Mutex
		var frames []protocol.TerminalServerFrame
		ptys := make([]*fakePty, 0, MaxTerminals)
		manager := NewManager(Options{
			Which: muxInstalled,
			Send: func(frame protocol.TerminalServerFrame) {
				mu.Lock()
				frames = append(frames, frame)
				mu.Unlock()
			},
			Spawn: func(Spec) (Process, error) {
				p := newFakePty()
				ptys = append(ptys, p)
				return p, nil
			},
		})
		t.Cleanup(func() {
			for _, p := range ptys {
				p.die(nil)
			}
		})

		name := "main"
		for i := 0; i < MaxTerminals; i++ {
			manager.Handle(&protocol.TerminalOpen{
				Type:   protocol.TermOpen,
				TermID: fmt.Sprintf("t%d", i),
				Target: sessionTarget(&name),
			})
		}
		if manager.Count() != MaxTerminals {
			t.Fatalf("count = %d, want %d", manager.Count(), MaxTerminals)
		}

		manager.Handle(&protocol.TerminalOpen{Type: protocol.TermOpen, TermID: "one-too-many", Target: sessionTarget(&name)})
		if manager.Count() != MaxTerminals {
			t.Fatalf("count = %d after the refusal", manager.Count())
		}

		mu.Lock()
		last := frames[len(frames)-1]
		mu.Unlock()
		failure, ok := last.(*protocol.TerminalError)
		if !ok || failure.TermID != "one-too-many" {
			t.Fatalf("last frame = %#v, want an error for the refused pane", last)
		}
		// The wording is what an operator sees in the pane and what
		// docs/OPERATIONS.md tells them to look for.
		if failure.Message != fmt.Sprintf("terminal limit reached (%d)", MaxTerminals) {
			t.Fatalf("refusal reads %q", failure.Message)
		}
		if len(ptys) != MaxTerminals {
			t.Fatalf("%d ptys were spawned for %d terminals", len(ptys), MaxTerminals)
		}
	})
}

// TestMultiplexerAbsent covers the host that simply does not have one. Installing
// it is the host owner's decision, so the agent's whole job here is to be clear.
func TestMultiplexerAbsent(t *testing.T) {
	noMux := func(string) (string, bool) { return "", false }

	// openOn drives one open and returns what the browser was sent, plus whether a
	// PTY was ever asked for.
	openOn := func(t *testing.T, which func(string) (string, bool), target protocol.TerminalTarget) ([]protocol.TerminalServerFrame, bool) {
		t.Helper()
		h := &harness{pty: newFakePty()}
		spawned := false
		h.manager = NewManager(Options{
			Which: which,
			Send: func(frame protocol.TerminalServerFrame) {
				h.mu.Lock()
				h.frames = append(h.frames, frame)
				h.mu.Unlock()
			},
			Spawn: func(Spec) (Process, error) { spawned = true; return h.pty, nil },
		})
		h.manager.Handle(&protocol.TerminalOpen{Type: protocol.TermOpen, TermID: "t1", Target: target})
		t.Cleanup(func() { h.pty.die(nil) })
		return h.sent(), spawned
	}

	errorFrame := func(t *testing.T, frames []protocol.TerminalServerFrame) *protocol.TerminalError {
		t.Helper()
		for _, frame := range frames {
			if failure, ok := frame.(*protocol.TerminalError); ok {
				return failure
			}
		}
		return nil
	}

	t.Run("[TC-PDTERM-029] a session is refused in a sentence, not in a Go error", func(t *testing.T) {
		name := "main"
		frames, spawned := openOn(t, noMux, sessionTarget(&name))

		failure := errorFrame(t, frames)
		if failure == nil {
			t.Fatal("no error frame; the browser would wait forever")
		}
		if failure.Message != MissingMultiplexerMessage {
			t.Fatalf("message = %q", failure.Message)
		}
		// What used to reach the screen. A person cannot see this agent's $PATH, so
		// naming it told them nothing they could act on.
		if strings.Contains(failure.Message, "$PATH") || strings.Contains(failure.Message, "exec:") {
			t.Fatalf("the raw exec error is back: %q", failure.Message)
		}
		// And the alternative is named, because there IS one.
		if !strings.Contains(failure.Message, "shell") {
			t.Fatalf("the refusal does not mention the shell option: %q", failure.Message)
		}
		if spawned {
			t.Fatal("a PTY was started for a target that cannot work")
		}
	})

	t.Run("[TC-PDTERM-029] a shell still opens on the same host", func(t *testing.T) {
		// The point of refusing precisely: a host with no multiplexer is not a host
		// with no terminal.
		frames, spawned := openOn(t, noMux, shellTarget())

		if failure := errorFrame(t, frames); failure != nil {
			t.Fatalf("shell refused: %q", failure.Message)
		}
		if !spawned {
			t.Fatal("no PTY was started for a shell target")
		}
	})

	t.Run("[TC-PDTERM-029] an installed multiplexer is not refused", func(t *testing.T) {
		// The control. Without it this file would pass just as well against code
		// that refused every session open.
		name := "main"
		frames, spawned := openOn(t, muxInstalled, sessionTarget(&name))

		if failure := errorFrame(t, frames); failure != nil {
			t.Fatalf("session refused on a host that has one: %q", failure.Message)
		}
		if !spawned {
			t.Fatal("no PTY was started for a session target")
		}
	})
}
