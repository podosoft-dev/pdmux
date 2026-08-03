package collect

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeTmux puts a `tmux` on PATH that behaves the way one branch of the real one
// does. The alternative — asserting against whatever tmux the machine running
// the suite happens to have — makes "no server running" untestable on a host
// where a server IS running, and untestable at all on a host with no tmux.
func fakeTmux(t *testing.T, script string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "tmux")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script+"\n"), 0o700); err != nil {
		t.Fatalf("writing fake tmux: %v", err)
	}
	t.Setenv("PATH", dir)
}

func TestSessions(t *testing.T) {
	t.Run("[TC-PDAGENT-013] parses name|attached|windows lines", func(t *testing.T) {
		got := parseSessions("main|1|3\nbuild|0|1\n")
		if len(got) != 2 {
			t.Fatalf("parsed %d sessions, want 2", len(got))
		}
		if got[0].Name != "main" || got[0].Attached != 1 || got[0].Windows != 3 {
			t.Fatalf("first session = %+v", got[0])
		}
		if got[1].Name != "build" || got[1].Attached != 0 || got[1].Windows != 1 {
			t.Fatalf("second session = %+v", got[1])
		}
	})

	t.Run("[TC-PDAGENT-013] defaults unparsable counts to zero", func(t *testing.T) {
		got := parseSessions("odd|x|\n")
		if len(got) != 1 || got[0].Name != "odd" || got[0].Attached != 0 || got[0].Windows != 0 {
			t.Fatalf("parsed %+v, want one session with zero counts", got)
		}
	})

	t.Run("[TC-PDAGENT-013] drops a nameless row and clips an absurd name", func(t *testing.T) {
		// Both are contract limits (name is 1..128 chars): a row that fails them
		// would fail the entire heartbeat, so it costs itself instead.
		long := strings.Repeat("s", 300)
		got := parseSessions("|1|1\n" + long + "|1|1\n")
		if len(got) != 1 {
			t.Fatalf("parsed %d sessions, want the nameless one dropped", len(got))
		}
		if len([]rune(got[0].Name)) != sessionNameMax {
			t.Fatalf("name length = %d, want %d", len([]rune(got[0].Name)), sessionNameMax)
		}
	})

	t.Run("[TC-PDAGENT-013] returns an empty list when tmux is missing", func(t *testing.T) {
		// ⚠ CLEARING PATH IS NOT ENOUGH. The lookup also searches per-user and
		// system install prefixes, so on a machine that really has tmux this found
		// it and the subtest passed while proving the opposite of its name.
		previous := resolveMux
		resolveMux = func() string { return "pdmux-no-such-multiplexer" }
		t.Cleanup(func() { resolveMux = previous })
		t.Setenv("PATH", "/nonexistent")
		reading := ReadSessions(t.Context(), 2_000)
		if reading.Present {
			t.Fatal("present = true with no tmux on PATH")
		}
		if reading.Sessions == nil || len(reading.Sessions) != 0 {
			t.Fatalf("sessions = %v, want an empty (non-nil) list", reading.Sessions)
		}
		// A host without a multiplexer produces [] and never an error.
		if got := Sessions(t.Context(), 2_000); len(got) != 0 {
			t.Fatalf("sessions = %v", got)
		}
	})

	t.Run("[TC-PDAGENT-013] distinguishes \"no multiplexer\" from \"no sessions\"", func(t *testing.T) {
		// Installed, but nothing running under it: tmux exits 1 and says so. That
		// is the ordinary state of a fresh host and must not raise `mux.missing`.
		fakeTmux(t, `echo "no server running on /tmp/tmux-0/default" >&2; exit 1`)
		reading := ReadSessions(t.Context(), 2_000)
		if !reading.Present {
			t.Fatal("present = false for an installed tmux with no server")
		}
		if len(reading.Sessions) != 0 {
			t.Fatalf("sessions = %v, want none", reading.Sessions)
		}
	})

	t.Run("[TC-PDAGENT-013] lists what tmux prints", func(t *testing.T) {
		fakeTmux(t, `printf 'main|1|3\nbuild|0|1\n'`)
		reading := ReadSessions(t.Context(), 2_000)
		if !reading.Present || len(reading.Sessions) != 2 {
			t.Fatalf("reading = %+v", reading)
		}
		if reading.Sessions[0].Name != "main" || reading.Sessions[1].Windows != 1 {
			t.Fatalf("sessions = %+v", reading.Sessions)
		}
	})
}
