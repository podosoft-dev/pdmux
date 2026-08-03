package term

import (
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/creack/pty"
)

// Window bounds. The contract already caps a terminal at 1000x500, and the
// ioctl takes uint16 — an out-of-range value would WRAP (65616 columns becomes
// 80) and hand the shell a size nobody asked for, so the value is clamped
// rather than converted. Terminal frames skip schema validation on arrival, so
// this is the layer that has to hold.
const (
	maxCols = 1000
	maxRows = 500
)

const (
	// readChunkBytes is one read(2) from the master. Big enough that a build log
	// is a handful of syscalls, small enough that a chatty pane does not hold a
	// megabyte per terminal.
	readChunkBytes = 32 << 10
	// outputQueueDepth lets the reader stay ahead of a consumer that is busy
	// framing. Past it the reader blocks, which is correct: the backpressure ends
	// at the kernel's pty buffer, and the manager's own cap is what decides which
	// bytes survive.
	outputQueueDepth = 64
	// killGrace is how long a terminated child has before SIGKILL.
	killGrace = 2 * time.Second
	// drainGrace is how long the reader gets to finish after the child exits.
	// Closing the master the instant Wait returns would cut off whatever the child
	// wrote last — which, for a command that just failed, is the only part anyone
	// wants to read.
	drainGrace = 250 * time.Millisecond
)

// Spec is what to run and how big its window starts.
type Spec struct {
	File string
	Args []string
	Cols int
	Rows int
	// Dir is the working directory; empty means the user's home.
	Dir string
	// Env replaces the environment when non-nil. Nil means the agent's own
	// environment with TERM set, which is what every current caller wants.
	Env []string
}

// Process is one live pseudo-terminal.
//
// ⚠ ORDERING CONTRACT: Output is closed BEFORE Exit delivers. A consumer that
// has seen a value on Exit can therefore drain Output to completion and know it
// holds every byte the child wrote. Without that rule the last screen of a
// command races the exit frame and loses, which reads as "the terminal ate my
// error message".
//
// A consumer must keep draining Output for the terminal's whole life; the
// producer blocks once the queue fills. Every chunk belongs to the consumer —
// an implementation that recycled its read buffer would rewrite bytes already
// sitting in a pane's flush queue.
type Process interface {
	// Pid is the child's process id, or nil when there is none to report. It goes
	// straight into the `ready` frame, where the contract's type is nullable.
	Pid() *int
	Write(data string) error
	Resize(cols, rows int) error
	// Kill ends the process GROUP, not just the child — see the implementation.
	Kill()
	Output() <-chan []byte
	// Exit delivers exactly one status and is then closed. A nil value means the
	// child was killed by a signal, which the contract renders as `null` rather
	// than as an exit code of 0.
	Exit() <-chan *int
}

// Spawn starts a command in a real pseudo-terminal.
//
// ONE PTY PATH, NO FALLBACK. The TypeScript agent had two: `node-pty` when the
// host happened to have a C++ toolchain at install time, and a `script(1)`
// impersonation when it did not — because an agent whose install can fail on a
// machine with no compiler is not self-hostable. github.com/creack/pty is the
// real thing through syscalls with no cgo, so the compiler is never needed and
// the fallback has nothing left to be a fallback FOR. It is deleted rather than
// ported, and with it go its limitations: resize is a genuine TIOCSWINSZ on
// Linux AND macOS (the script path could only re-run `stty` against a slave tty
// it resolved through /proc, so a resize on macOS was silently a no-op), the
// pty is the child's own controlling terminal rather than one borrowed from a
// helper process, and no part of the command line passes through `sh -c` — argv
// is argv, so there is no shell left to quote for.
func Spawn(spec Spec) (Process, error) {
	cmd := exec.Command(spec.File, spec.Args...)
	cmd.Dir = spec.Dir
	if cmd.Dir == "" {
		cmd.Dir = homeDir()
	}
	cmd.Env = spec.Env
	if cmd.Env == nil {
		cmd.Env = terminalEnv(os.Environ())
	}

	cols, rows := clampWindow(spec.Cols, spec.Rows)
	// StartWithSize puts the child in its own session with the pty as its
	// controlling terminal, which is what makes job control, ^C and SIGWINCH work
	// at all — and what makes the child's pid its process-group id, which Kill
	// relies on.
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: rows, Cols: cols})
	if err != nil {
		return nil, err
	}

	p := &ptyProcess{
		cmd:    cmd,
		ptmx:   ptmx,
		pid:    cmd.Process.Pid,
		output: make(chan []byte, outputQueueDepth),
		exit:   make(chan *int, 1),
	}
	readerDone := make(chan struct{})
	go p.read(readerDone)
	go p.wait(readerDone)
	return p, nil
}

type ptyProcess struct {
	cmd  *exec.Cmd
	ptmx *os.File
	pid  int

	output chan []byte
	exit   chan *int

	killOnce sync.Once
	// exited is read by the delayed SIGKILL, from a timer goroutine.
	exited atomic.Bool
}

func (p *ptyProcess) Pid() *int {
	pid := p.pid
	return &pid
}

func (p *ptyProcess) Output() <-chan []byte { return p.output }

func (p *ptyProcess) Exit() <-chan *int { return p.exit }

func (p *ptyProcess) Write(data string) error {
	_, err := p.ptmx.WriteString(data)
	return err
}

// Resize applies a new window size to the master, which makes the kernel deliver
// SIGWINCH to the foreground process group — the signal tmux, vim and less
// redraw on. This is the operation the script(1) fallback could not perform.
func (p *ptyProcess) Resize(cols, rows int) error {
	c, r := clampWindow(cols, rows)
	return pty.Setsize(p.ptmx, &pty.Winsize{Rows: r, Cols: c})
}

// Kill ends the process GROUP.
//
// An interactive shell ignores SIGTERM, so signalling the child alone leaves a
// bash (and everything it started) alive forever — measured in the TypeScript
// agent as two orphaned shells surviving a spec run that closed its terminals.
// The child is a session leader, so its pid is also its process-group id and a
// negative signal reaches everything inside. For a `session` terminal that group
// holds only the tmux CLIENT: the tmux server is its own session, which is
// exactly why the work survives.
func (p *ptyProcess) Kill() {
	p.killOnce.Do(func() {
		// ⚠ A reaped pid is reusable. CloseAll on a dropped socket routinely kills
		// terminals whose shell exited minutes ago, and signalling that number
		// would reach whatever process now owns it.
		if p.exited.Load() {
			return
		}
		signalGroup(p.pid, syscall.SIGTERM)
		// The escalation needs no unref (the Node original had one): a pending Go
		// timer does not hold the process open.
		time.AfterFunc(killGrace, func() {
			// ⚠ Never signal a reaped pid: the number is reusable, and on a busy
			// host "SIGKILL the group two seconds later" would eventually land on
			// somebody else's processes.
			if p.exited.Load() {
				return
			}
			signalGroup(p.pid, syscall.SIGKILL)
		})
	})
}

// read pumps the master into Output until the child is gone.
func (p *ptyProcess) read(done chan<- struct{}) {
	defer close(done)
	defer close(p.output)

	buf := make([]byte, readChunkBytes)
	var partial []byte
	for {
		n, err := p.ptmx.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			if len(partial) > 0 {
				chunk = append(partial, chunk...)
				partial = nil
			}
			// A UTF-8 sequence split across two reads must not be emitted in
			// halves: each half becomes U+FFFD the moment the frame is JSON
			// encoded, so one Korean character typed at a prompt would come back
			// as two permanent replacement characters. Hold the tail instead.
			complete, rest := splitRune(chunk)
			if len(rest) > 0 {
				partial = append([]byte(nil), rest...)
			}
			if len(complete) > 0 {
				out := make([]byte, len(complete))
				copy(out, complete)
				p.output <- out
			}
		}
		if err != nil {
			// EIO from a pty master is how the kernel says "the last slave closed",
			// i.e. the child exited. It is the ordinary end of every terminal, not a
			// failure to report. Whatever partial sequence is left is emitted
			// as-is: the child is gone, so the rest of that rune is never coming.
			if len(partial) > 0 {
				p.output <- partial
			}
			return
		}
	}
}

// wait reaps the child and publishes its status, after the reader is done.
func (p *ptyProcess) wait(readerDone <-chan struct{}) {
	err := p.cmd.Wait()
	p.exited.Store(true)

	select {
	case <-readerDone:
		// The reader saw EIO on its own and drained the tail.
	case <-time.After(drainGrace):
		// It did not; close the master so the blocked Read returns. A pane must not
		// stay open because one process left a file descriptor behind.
	}
	_ = p.ptmx.Close()
	<-readerDone

	p.exit <- exitCode(err)
	close(p.exit)
}

// exitCode maps a Wait error onto the contract's nullable code.
func exitCode(err error) *int {
	if err == nil {
		zero := 0
		return &zero
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			// A signalled child has no exit code. Reporting 0 would tell the browser
			// the shell finished cleanly; `null` is the honest answer and the one the
			// contract has a shape for.
			return nil
		}
		if code := exitErr.ExitCode(); code >= 0 {
			return &code
		}
	}
	return nil
}

// signalGroup signals the whole group, falling back to the process itself where
// the platform (or a lost group) refuses.
func signalGroup(pid int, signal syscall.Signal) {
	if err := syscall.Kill(-pid, signal); err == nil {
		return
	}
	_ = syscall.Kill(pid, signal)
}

// clampWindow converts a requested size into the ioctl's uint16 without ever
// wrapping. See maxCols/maxRows.
func clampWindow(cols, rows int) (uint16, uint16) {
	return clampDimension(cols, maxCols), clampDimension(rows, maxRows)
}

func clampDimension(value, max int) uint16 {
	if value < 1 {
		return 1
	}
	if value > max {
		return uint16(max)
	}
	return uint16(value)
}

// splitRune divides p into the bytes that are safe to emit now and the trailing
// bytes of an incomplete UTF-8 sequence, which belong to the next read.
func splitRune(p []byte) (complete, partial []byte) {
	// A sequence is at most 4 bytes, so only the last 3 can be incomplete.
	for i := len(p) - 1; i >= 0 && i >= len(p)-3; i-- {
		b := p[i]
		if b < 0x80 {
			return p, nil // ASCII: nothing can be pending behind it.
		}
		if b&0xC0 == 0xC0 { // a start byte
			need := runeLen(b)
			if need > 0 && len(p)-i < need {
				return p[:i], p[i:]
			}
			return p, nil
		}
		// A continuation byte: keep walking back to find its start byte.
	}
	return p, nil
}

func runeLen(start byte) int {
	switch {
	case start&0xE0 == 0xC0:
		return 2
	case start&0xF0 == 0xE0:
		return 3
	case start&0xF8 == 0xF0:
		return 4
	default:
		return 0 // Not a legal start byte; emit it and let the decoder complain.
	}
}

// terminalEnv is the environment every pane's child gets.
//
// ⚠ IT HAS TO SUPPLY A CHARACTER ENCODING, because a service manager does not. An
// agent started by launchd or systemd inherits no LANG, no LC_ALL and no LC_CTYPE —
// checked on a running install, all three absent — so every child ran in the C
// locale. tmux decides whether its CLIENT can render UTF-8 from exactly those
// variables, and when it decides no it replaces each byte of a multi-byte character
// with an underscore. Reported as "Korean types as ____ in pdmux but is fine in a
// normal terminal", and reproduced by attaching a client with the variables stripped:
// tmux sent zero bytes of the Korean text and four underscore runs.
//
// ⚠ ONLY WHEN THE OPERATOR SUPPLIED NONE. A unit file that sets a locale is a
// deliberate choice and overriding it would be this code deciding it knows better.
//
// ⚠ AND ONLY `LC_CTYPE`. That is the category that governs encoding; setting `LANG`
// would also move messages, collation and time formats, which is more than the bug
// needs and more than anyone asked for.
func terminalEnv(base []string) []string {
	out := make([]string, 0, len(base)+2)
	locale := false
	for _, entry := range base {
		if strings.HasPrefix(entry, "TERM=") {
			continue
		}
		if isSetLocale(entry) {
			locale = true
		}
		out = append(out, entry)
	}
	// Without this a shell assumes a dumb terminal and stops emitting colour and
	// cursor movement — the pane works but looks broken.
	out = append(out, "TERM=xterm-256color")
	if !locale {
		out = append(out, "LC_CTYPE="+utf8Locale())
	}
	return out
}

// isSetLocale reports whether an environment entry names a locale AND gives it a
// value. POSIX treats an empty one as unset, and `LC_ALL=` is a shape that really
// occurs — counting it would leave the encoding unset while looking handled.
func isSetLocale(entry string) bool {
	for _, name := range [...]string{"LC_ALL=", "LC_CTYPE=", "LANG="} {
		if strings.HasPrefix(entry, name) {
			return len(entry) > len(name)
		}
	}
	return false
}

// utf8Locale is the encoding to fall back to, spelled the way the platform spells it.
//
// ⚠ THE TWO SPELLINGS ARE NOT INTERCHANGEABLE. tmux only looks for "UTF-8" inside the
// string, so either would satisfy it — but every other program in the pane calls
// setlocale, which fails on a locale the system does not have and silently leaves them
// in C. macOS has no `C.UTF-8`; its BSD spelling is the bare `UTF-8`. Linux has
// `C.UTF-8` and not the bare form.
func utf8Locale() string {
	if runtime.GOOS == "darwin" {
		return "UTF-8"
	}
	return "C.UTF-8"
}

// homeDir is where a terminal opens when the caller does not say.
//
// The agent's own working directory is the wrong answer: under systemd it is
// `/`, and a login shell that opens in the root of the filesystem reads as a
// broken host. A $HOME that does not exist is worse than useless — exec would
// fail with a chdir error and the pane would never open at all — so it is
// checked rather than trusted.
func homeDir() string {
	home := os.Getenv("HOME")
	if home == "" {
		return ""
	}
	if info, err := os.Stat(home); err != nil || !info.IsDir() {
		return ""
	}
	return home
}
