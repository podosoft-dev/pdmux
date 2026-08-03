package term

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Every test here drives a REAL pty. That is the point: the thing being ported
// is a syscall dance, and a mocked one proves nothing about whether a shell can
// be typed into. Each is bounded by a deadline so a wedged child cannot hang CI.

const ptyTimeout = 10 * time.Second

// recorder drains a Process's Output for its whole life, which is the contract
// Process states: a consumer that stops reading blocks the producer.
type recorder struct {
	mu   sync.Mutex
	buf  bytes.Buffer
	done chan struct{}
}

func record(p Process) *recorder {
	r := &recorder{done: make(chan struct{})}
	go func() {
		defer close(r.done)
		for chunk := range p.Output() {
			r.mu.Lock()
			r.buf.Write(chunk)
			r.mu.Unlock()
		}
	}()
	return r
}

func (r *recorder) text() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.buf.String()
}

func (r *recorder) reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buf.Reset()
}

func waitFor(t *testing.T, timeout time.Duration, what string, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// shellPath is the one interpreter every unix has. A host without it cannot run
// this test at all, which is a skip rather than a failure.
func shellPath(t *testing.T) string {
	t.Helper()
	const sh = "/bin/sh"
	if _, err := os.Stat(sh); err != nil {
		t.Skipf("no %s on this platform: %v", sh, err)
	}
	return sh
}

// startShell spawns a shell reading commands from the pty and guarantees it is
// gone when the test ends.
func startShell(t *testing.T, cols, rows int) Process {
	t.Helper()
	p, err := Spawn(Spec{File: shellPath(t), Cols: cols, Rows: rows})
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	t.Cleanup(func() {
		p.Kill()
		select {
		case <-p.Exit():
		case <-time.After(ptyTimeout):
			t.Error("pty did not exit after Kill")
		}
	})
	return p
}

func TestPty(t *testing.T) {
	t.Run("[TC-PDTERM-021] echoes a command through a real pty", func(t *testing.T) {
		p := startShell(t, 80, 24)
		out := record(p)
		if p.Pid() == nil || *p.Pid() <= 0 {
			t.Fatalf("pid = %v, want a real one for the ready frame", p.Pid())
		}
		// Written so the ECHO of the input differs from the command's output:
		// seeing `pdmux-ok` proves the shell ran, not just that a tty echoed.
		if err := p.Write("echo \"pdmux-\"\"ok\"\n"); err != nil {
			t.Fatalf("write: %v", err)
		}
		waitFor(t, ptyTimeout, "the shell to answer", func() bool {
			return strings.Contains(out.text(), "pdmux-ok")
		})
	})

	t.Run("[TC-PDTERM-022] applies a resize to the terminal the shell sees", func(t *testing.T) {
		p := startShell(t, 80, 24)
		out := record(p)
		if err := p.Write("stty size\n"); err != nil {
			t.Fatalf("write: %v", err)
		}
		waitFor(t, ptyTimeout, "the opening size", func() bool {
			return strings.Contains(out.text(), "24 80")
		})

		out.reset()
		if err := p.Resize(120, 40); err != nil {
			t.Fatalf("resize: %v", err)
		}
		// ONE ASK IS ENOUGH, ON EVERY PLATFORM. The TypeScript asked repeatedly for
		// up to ten seconds because its script(1) fallback re-applied the size out
		// of band — `stty` against a slave tty it resolved through /proc — and on
		// macOS, with no /proc, a resize after start was silently a no-op. This is
		// a TIOCSWINSZ on the master, so the kernel has already changed the window
		// (and signalled SIGWINCH) before Resize returns.
		if err := p.Write("stty size\n"); err != nil {
			t.Fatalf("write: %v", err)
		}
		waitFor(t, ptyTimeout, "the resized terminal", func() bool {
			return strings.Contains(out.text(), "40 120")
		})
	})

	t.Run("[TC-PDTERM-026] reports the child's exit status, and `null` when it was signalled", func(t *testing.T) {
		p, err := Spawn(Spec{File: shellPath(t), Args: []string{"-c", "exit 7"}, Cols: 80, Rows: 24})
		if err != nil {
			t.Fatalf("spawn: %v", err)
		}
		record(p)
		select {
		case code := <-p.Exit():
			if code == nil || *code != 7 {
				t.Fatalf("exit code = %v, want 7", code)
			}
		case <-time.After(ptyTimeout):
			t.Fatal("timed out waiting for the child to exit")
		}

		killed := startShell(t, 80, 24)
		record(killed)
		killed.Kill()
		select {
		case code := <-killed.Exit():
			// A signalled child has no exit code; 0 would tell the browser the shell
			// finished cleanly.
			if code != nil {
				t.Fatalf("signalled child reported code %d, want null", *code)
			}
		case <-time.After(ptyTimeout):
			t.Fatal("timed out waiting for the killed child")
		}
	})

	t.Run("[TC-PDTERM-023] passes argv straight to the child, with no shell to quote for", func(t *testing.T) {
		// The TypeScript's fallback built a `sh -c` command line, which is why it
		// needed shellQuote() and why the quoting had its own test. Nothing here
		// goes near a shell: a metacharacter is just a byte in argv.
		hostile := "a; rm -rf /"
		p, err := Spawn(Spec{
			File: shellPath(t),
			Args: []string{"-c", `printf "[%s]" "$1"`, "sh", hostile},
			Cols: 80,
			Rows: 24,
		})
		if err != nil {
			t.Fatalf("spawn: %v", err)
		}
		out := record(p)
		waitFor(t, ptyTimeout, "the argument to come back intact", func() bool {
			return strings.Contains(out.text(), "["+hostile+"]")
		})
	})

	// Untagged: no TC pins where a terminal opens or what TERM it gets. Both are
	// worth holding — the TypeScript's two modes disagreed about the directory
	// (node-pty inherited the agent's, which under systemd is `/`), and a pane
	// that opens at the root of the filesystem reads as a broken host.
	t.Run("starts the child in $HOME with a TERM it can draw with", func(t *testing.T) {
		home := os.Getenv("HOME")
		if home == "" {
			t.Skip("no $HOME to check against")
		}
		p, err := Spawn(Spec{
			File: shellPath(t),
			Args: []string{"-c", `printf "[%s][%s]" "$(pwd)" "$TERM"`},
			Cols: 80,
			Rows: 24,
		})
		if err != nil {
			t.Fatalf("spawn: %v", err)
		}
		out := record(p)
		waitFor(t, ptyTimeout, "the child to report where it is", func() bool {
			return strings.Contains(out.text(), "[xterm-256color]")
		})
		resolved, err := filepath.EvalSymlinks(home)
		if err != nil {
			resolved = home
		}
		text := out.text()
		if !strings.Contains(text, "["+home+"]") && !strings.Contains(text, "["+resolved+"]") {
			t.Fatalf("child started in %q, want $HOME (%s)", text, home)
		}
	})
}

// Untagged: the TypeScript decoded pty reads into a string with StringDecoder,
// which held a split sequence for the same reason. There is no TC for it, and
// the consequence is worse here: an invalid byte in a JSON string is replaced
// with U+FFFD by the encoder, so a halved rune is corrupted permanently rather
// than reassembled by the next chunk.
func TestSplitRune(t *testing.T) {
	t.Run("holds an incomplete UTF-8 sequence until the rest of it arrives", func(t *testing.T) {
		full := []byte("한글")       // two 3-byte runes
		head := full[:len(full)-1] // the last rune is one byte short

		complete, partial := splitRune(head)
		if string(complete) != "한" || len(partial) != 2 {
			t.Fatalf("complete = %q, partial = %v", complete, partial)
		}
		// Once the missing byte arrives the whole sequence is emitted.
		complete, partial = splitRune(append(append([]byte(nil), partial...), full[len(full)-1]))
		if string(complete) != "글" || partial != nil {
			t.Fatalf("complete = %q, partial = %v", complete, partial)
		}
		// ASCII and complete sequences are never held back.
		for _, whole := range []string{"plain ascii", "한글", "é", "🙂"} {
			complete, partial := splitRune([]byte(whole))
			if string(complete) != whole || partial != nil {
				t.Fatalf("%q was split into %q + %v", whole, complete, partial)
			}
		}
		// A byte that cannot start a sequence is emitted rather than held forever —
		// binary output must not wedge the pane.
		if complete, partial := splitRune([]byte{0xFF}); len(complete) != 1 || partial != nil {
			t.Fatalf("invalid byte held back: %v + %v", complete, partial)
		}
	})
}

/**
 * ⚠ THE BUG THIS GUARDS IS INVISIBLE IN A DEVELOPER'S SHELL. A person running the
 * agent by hand has LANG set, so the fallback never fires and everything looks
 * right; under launchd or systemd the variables are simply absent. That is why the
 * base environment here is written out rather than taken from `os.Environ()` — a
 * test that inherited the developer's locale would pass against both the broken and
 * the fixed code.
 *
 * What went wrong without it: tmux reads these variables to decide whether its
 * client can render UTF-8, and when it decides no it draws each byte of a multi-byte
 * character as an underscore. Korean typed into a pdmux pane came back as `____`
 * while the same session in a normal terminal was fine.
 */
func TestTerminalEnv(t *testing.T) {
	has := func(env []string, prefix string) string {
		for _, entry := range env {
			if strings.HasPrefix(entry, prefix) {
				return entry
			}
		}
		return ""
	}

	t.Run("[TC-PDTERM-021] supplies an encoding when the service manager gave none", func(t *testing.T) {
		env := terminalEnv([]string{"PATH=/usr/bin", "HOME=/home/ubuntu"})
		ctype := has(env, "LC_CTYPE=")
		if ctype == "" {
			t.Fatal("no LC_CTYPE: every pane would run in the C locale and tmux would draw multi-byte text as underscores")
		}
		if !strings.Contains(ctype, "UTF-8") {
			t.Fatalf("LC_CTYPE = %q, want a UTF-8 encoding", ctype)
		}
		if has(env, "TERM=") != "TERM=xterm-256color" {
			t.Fatalf("TERM = %q", has(env, "TERM="))
		}
	})

	t.Run("[TC-PDTERM-021] leaves an operator's own locale alone", func(t *testing.T) {
		for _, chosen := range []string{"LANG=ko_KR.UTF-8", "LC_CTYPE=ja_JP.eucJP", "LC_ALL=de_DE.UTF-8"} {
			env := terminalEnv([]string{"PATH=/usr/bin", chosen})
			// A unit file that names a locale made a decision; adding one beside it
			// would quietly win, because LC_CTYPE outranks LANG.
			if added := has(env, "LC_CTYPE="); added != "" && added != chosen {
				t.Fatalf("with %s the environment also got %q", chosen, added)
			}
		}
	})

	t.Run("[TC-PDTERM-021] treats an empty locale as absent, the way POSIX does", func(t *testing.T) {
		// `LC_ALL=` with no value is a real shape, and reading it as "set" would leave
		// the encoding unset while looking handled.
		env := terminalEnv([]string{"PATH=/usr/bin", "LC_ALL=", "LANG="})
		if ctype := has(env, "LC_CTYPE="); !strings.Contains(ctype, "UTF-8") {
			t.Fatalf("LC_CTYPE = %q, want a UTF-8 encoding", ctype)
		}
	})
}
