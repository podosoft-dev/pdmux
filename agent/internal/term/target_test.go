//go:build !windows

package term

import (
	"errors"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"path/filepath"
	"strings"
	"testing"
)

func env(pairs map[string]string) func(string) string {
	return func(key string) string { return pairs[key] }
}

// attachMain attaches to `main`, applies the shared-size policy to its current
// window, and marks a window it created as inheriting (see window_size.go).
const attachMain = "new -A -s main ; set-window-option -t =main: window-size largest ; " +
	"set-option -w -o -q -t =main: @pdmux-window-size inherit"

func TestResolveTarget(t *testing.T) {
	t.Run("[TC-PDTERM-023] attaches to (or creates) a named multiplexer session", func(t *testing.T) {
		name := "main"
		resolved, err := ResolveTarget(sessionTarget(&name), env(nil))
		if err != nil {
			t.Fatalf("resolve: %v", err)
		}
		// The BASENAME, not the string: the file is resolved through the same lookup
		// the collector uses, so on a host where the multiplexer was installed into a
		// per-user prefix this is an absolute path — which is the whole point. What
		// must not change is which binary, and the arguments.
		if filepath.Base(resolved.File) != "tmux" || strings.Join(resolved.Args, " ") != attachMain {
			t.Fatalf("resolved %q %v", resolved.File, resolved.Args)
		}
		if resolved.Label != "session:main" || resolved.Session != "main" {
			t.Fatalf("label = %q, session = %q", resolved.Label, resolved.Session)
		}
	})

	t.Run("[TC-PDTERM-023] defaults to the `main` session", func(t *testing.T) {
		resolved, err := ResolveTarget(sessionTarget(nil), env(nil))
		if err != nil {
			t.Fatalf("resolve: %v", err)
		}
		if strings.Join(resolved.Args, " ") != attachMain {
			t.Fatalf("args = %v", resolved.Args)
		}
	})

	t.Run("[TC-PDTERM-023] runs a bare login shell for kind=shell", func(t *testing.T) {
		resolved, err := ResolveTarget(shellTarget(), env(map[string]string{"SHELL": "/bin/zsh"}))
		if err != nil {
			t.Fatalf("resolve: %v", err)
		}
		if resolved.File != "/bin/zsh" || strings.Join(resolved.Args, " ") != "-l" || resolved.Label != "shell" || resolved.Session != "" {
			t.Fatalf("resolved %+v", resolved)
		}
		// A $SHELL that is not an absolute path would be looked up on PATH, so it
		// is refused in favour of a known one.
		for _, bogus := range []string{"", "zsh", "../zsh"} {
			resolved, err := ResolveTarget(shellTarget(), env(map[string]string{"SHELL": bogus}))
			if err != nil {
				t.Fatalf("resolve %q: %v", bogus, err)
			}
			if resolved.File != fallbackShell {
				t.Fatalf("SHELL=%q resolved to %q, want the fallback", bogus, resolved.File)
			}
		}
	})

	t.Run("[TC-PDTERM-023] refuses a session name that could reach the shell", func(t *testing.T) {
		// The value becomes argv for `tmux`. Every one of these is refused HERE even
		// though the contract's own pattern would have refused it too — the frame
		// may have been relayed by a server built from a different version of it.
		refused := []string{
			"a; rm -rf /",
			"$(id)",
			"`id`",
			"a b",
			"../../etc/passwd",
			"main\nkill",
			"",
			strings.Repeat("x", 33),
		}
		for _, name := range refused {
			_, err := ResolveTarget(sessionTarget(&name), env(nil))
			var invalid *InvalidTargetError
			if !errors.As(err, &invalid) {
				t.Fatalf("session name %q was accepted (err = %v)", name, err)
			}
		}
		// The message is echoed to a browser, so a huge name is cut down first.
		long := strings.Repeat("y", 500)
		_, err := ResolveTarget(sessionTarget(&long), env(nil))
		if err == nil || len(err.Error()) > 128 {
			t.Fatalf("refusal message is %d bytes: %v", len(err.Error()), err)
		}
	})
}

func TestTmuxStableTarget(t *testing.T) {
	// A live ID resolves to an attach and never to `new -s`, which would start a
	// replacement tmux session under the old name. Whether the saved ID is still
	// live is decided before this, by name and id together (TC-PDTERM-161..164):
	// a gone one becomes a native session announced as reopened, never tmux.
	t.Run("[TC-PDUI-237] a live ID attaches without starting a replacement tmux session", func(t *testing.T) {
		id, old := "$12", "before"
		resolved, err := ResolveTarget(protocol.TerminalTarget{Kind: protocol.TerminalSession, TmuxID: &id, Session: &old}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if resolved.Session != id || len(resolved.Args) < 3 || resolved.Args[0] != "attach-session" || resolved.Args[2] != id {
			t.Fatalf("unstable attach: %+v", resolved)
		}
		for _, unsafe := range []string{"name", "-a", "$1;kill-server"} {
			if _, err := ResolveTarget(protocol.TerminalTarget{Kind: protocol.TerminalSession, TmuxID: &unsafe}, nil); err == nil {
				t.Fatalf("accepted %q", unsafe)
			}
		}
	})
}
