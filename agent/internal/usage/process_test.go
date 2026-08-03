package usage

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// fakeProcTable builds a process table on disk, so the count is the same on a
// laptop with four agents running as on a CI box with none.
func fakeProcTable(t *testing.T, entries map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for pid, comm := range entries {
		dir := filepath.Join(root, pid)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatalf("creating %s: %v", dir, err)
		}
		if err := os.WriteFile(filepath.Join(dir, "comm"), []byte(comm+"\n"), 0o600); err != nil {
			t.Fatalf("writing comm for %s: %v", pid, err)
		}
	}
	return root
}

// fakePgrep puts a `pgrep` on PATH: the fallback must be testable on a host that
// has /proc (where it never runs) and on one that has no pgrep at all.
func fakePgrep(t *testing.T, script string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "pgrep"), []byte("#!/bin/sh\n"+script+"\n"), 0o700); err != nil {
		t.Fatalf("writing fake pgrep: %v", err)
	}
	t.Setenv("PATH", dir)
}

func TestCountProcesses(t *testing.T) {
	t.Run("[TC-PDAGENT-017] counts by exact process name, not by command line", func(t *testing.T) {
		root := fakeProcTable(t, map[string]string{
			"101": "claude",
			"102": "claude",
			// The four decoys that inflated the count 8-vs-4 in the tool this ports:
			// a multiplexer session NAMED after the CLI, a grep for it, an editor open
			// on a file named after it, and a different binary that starts with it.
			"201": "tmux",
			"202": "grep",
			"203": "vim",
			"204": "claude-wrapper",
		})
		// /proc holds non-numeric entries too (`self`, `net`, …); they are not processes.
		if err := os.MkdirAll(filepath.Join(root, "self"), 0o700); err != nil {
			t.Fatalf("creating self: %v", err)
		}

		count, ok := CountFromProc("claude", root)
		if !ok {
			t.Fatal("could not read the fixture process table")
		}
		if count != 2 {
			t.Fatalf("count = %d, want 2", count)
		}
		absent, ok := CountFromProc("codex", root)
		if !ok || absent != 0 {
			t.Fatalf("count = %d (ok=%v), want 0 for a CLI that is not running", absent, ok)
		}
	})

	t.Run("[TC-PDAGENT-017] returns null when /proc is not readable", func(t *testing.T) {
		// "Could not look" and "nothing is running" are different answers: the first
		// is what makes the caller fall back to pgrep instead of reporting zero.
		if _, ok := CountFromProc("claude", filepath.Join(t.TempDir(), "missing")); ok {
			t.Fatal("reported a count from an unreadable process table")
		}
	})

	t.Run("falls back to pgrep -x where there is no /proc", func(t *testing.T) {
		missing := filepath.Join(t.TempDir(), "missing")

		// One pid per line — what both pgrep implementations print by default. The
		// count used to come from `-c`, which only procps has (see TC-PDMCP-004).
		fakePgrep(t, `printf '101\n102\n103\n'`)
		if got := CountProcesses(t.Context(), "claude", ProcessCountOptions{ProcDir: missing}); got != 3 {
			t.Fatalf("count = %d, want 3", got)
		}

		// pgrep exits 1 with no output when nothing matched: an answer, not a failure.
		fakePgrep(t, "exit 1")
		if got := CountProcesses(t.Context(), "claude", ProcessCountOptions{ProcDir: missing}); got != 0 {
			t.Fatalf("count = %d, want 0", got)
		}

		// Neither /proc nor pgrep: still a number, because a heartbeat that fails as
		// a whole looks exactly like a host that went down.
		t.Setenv("PATH", filepath.Join(t.TempDir(), "empty"))
		if got := CountProcesses(t.Context(), "claude", ProcessCountOptions{ProcDir: missing}); got != 0 {
			t.Fatalf("count = %d, want 0", got)
		}
	})

	t.Run("ignores pgrep output that is not a count", func(t *testing.T) {
		missing := filepath.Join(t.TempDir(), "missing")
		fakePgrep(t, `printf 'not a number\n'`)
		if got := CountProcesses(t.Context(), "claude", ProcessCountOptions{ProcDir: missing}); got != 0 {
			t.Fatalf("count = %d, want 0", got)
		}
	})
}

// The fallback that runs on every host without /proc — which in this fleet means
// every Mac.
func TestCountProcessesFallback(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("the fallback is only reached without /proc")
	}

	t.Run("[TC-PDMCP-010] counts this host's own processes rather than always zero", func(t *testing.T) {
		// ⚠ THE BUG THIS PINS: the fallback used `pgrep -c`, which is procps'. BSD
		// pgrep — the one on the hosts that actually reach this code — has no `-c`
		// and exits 2 with a usage error, which read as "no processes running". So
		// every Mac reported 0 for every provider, and the card said "no budget
		// reported" next to a CLI that was running.
		//
		// Counted against processes this test starts, so the number is known rather
		// than whatever happens to run on the machine.
		const want = 2
		for range want {
			command := exec.Command("sleep", "30")
			if err := command.Start(); err != nil {
				t.Skipf("cannot start a process to count: %v", err)
			}
			t.Cleanup(func() {
				_ = command.Process.Kill()
				_ = command.Wait()
			})
		}

		// ⚠ A path that does not exist, not an empty directory. An empty but READABLE
		// /proc is "zero processes" and never reaches the fallback — which is how the
		// first version of this test passed against the broken code.
		absent := filepath.Join(t.TempDir(), "no-proc-here")
		got := CountProcesses(context.Background(), "sleep", ProcessCountOptions{ProcDir: absent})
		if got < want {
			t.Fatalf("counted %d processes named sleep, want at least the %d started here", got, want)
		}
	})

	t.Run("[TC-PDMCP-010] still answers zero for something that is not running", func(t *testing.T) {
		absent := filepath.Join(t.TempDir(), "no-proc-here")
		got := CountProcesses(context.Background(), "pdmux-definitely-not-running", ProcessCountOptions{ProcDir: absent})
		if got != 0 {
			t.Fatalf("counted %d, want 0", got)
		}
	})
}
