package term

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

func sessionTarget(name *string) protocol.TerminalTarget {
	target := protocol.NewTerminalTarget()
	target.Kind = protocol.TerminalSession
	target.Session = name
	return target
}

func shellTarget() protocol.TerminalTarget {
	target := protocol.NewTerminalTarget()
	target.Kind = protocol.TerminalShell
	return target
}

func env(pairs map[string]string) func(string) string {
	return func(key string) string { return pairs[key] }
}

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
		if filepath.Base(resolved.File) != "tmux" || strings.Join(resolved.Args, " ") != "new -A -s main" {
			t.Fatalf("resolved %q %v", resolved.File, resolved.Args)
		}
		if resolved.Label != "session:main" {
			t.Fatalf("label = %q", resolved.Label)
		}
	})

	t.Run("[TC-PDTERM-023] defaults to the `main` session", func(t *testing.T) {
		resolved, err := ResolveTarget(sessionTarget(nil), env(nil))
		if err != nil {
			t.Fatalf("resolve: %v", err)
		}
		if strings.Join(resolved.Args, " ") != "new -A -s main" {
			t.Fatalf("args = %v", resolved.Args)
		}
	})

	t.Run("[TC-PDTERM-023] runs a bare login shell for kind=shell", func(t *testing.T) {
		resolved, err := ResolveTarget(shellTarget(), env(map[string]string{"SHELL": "/bin/zsh"}))
		if err != nil {
			t.Fatalf("resolve: %v", err)
		}
		if resolved.File != "/bin/zsh" || strings.Join(resolved.Args, " ") != "-l" || resolved.Label != "shell" {
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
