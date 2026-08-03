package usage

// Count live processes of a CLI by EXACT PROCESS NAME.
//
// ⚠ NEVER MATCH THE COMMAND LINE. A cmdline grep counted `tmux new -A -s
// claude-1`, a shell running `grep claude` and an editor open on `claude.md` —
// measured 8 matches against 4 real agents, which is enough to keep a host
// reading "busy" with nothing running on it.
//
// /proc/<pid>/comm is the kernel's own name for the process, so the match is
// exact by construction. Hosts without /proc fall back to `pgrep -c -x`, which
// has the same semantics (`-x` = exact, no `-f`).
//
// Ported from apps/agent/src/usage/process-count.ts.

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"strings"

	"github.com/podosoft-dev/pdmux/agent/internal/sys"
)

// DefaultProcDir is the kernel's process table.
const DefaultProcDir = "/proc"

// defaultProcessTimeoutMs bounds the pgrep fallback. Counting processes must cost
// this pass its count and never the whole heartbeat.
const defaultProcessTimeoutMs = 3_000

// ProcessCountOptions carries the injectable parts; a zero value counts the real
// host.
type ProcessCountOptions struct {
	// ProcDir is injected so a spec can build a fixture process table.
	ProcDir   string
	TimeoutMs int
}

// CountFromProc counts by scanning /proc. ok is false when /proc is unreadable
// (a non-Linux host) — which is a different answer from "zero processes running"
// and is why the caller falls back rather than reporting 0.
//
// ⚠ The kernel truncates comm to 15 characters, and `pgrep -x` compares against
// the same truncated name. A provider whose binary name is longer would never
// match either way; it is a property of the process table, not of this code.
func CountFromProc(name, procDir string) (int, bool) {
	if procDir == "" {
		procDir = DefaultProcDir
	}
	entries, err := os.ReadDir(procDir)
	if err != nil {
		return 0, false
	}
	count := 0
	for _, entry := range entries {
		if !isPID(entry.Name()) {
			continue
		}
		comm, err := os.ReadFile(filepath.Join(procDir, entry.Name(), "comm"))
		if err != nil {
			// The process exited between readdir and read — ordinary, not an error.
			continue
		}
		if strings.TrimSpace(string(comm)) == name {
			count++
		}
	}
	return count, true
}

// CountProcesses counts live processes of one CLI, whatever the host offers.
func CountProcesses(ctx context.Context, name string, options ProcessCountOptions) int {
	if count, ok := CountFromProc(name, options.ProcDir); ok {
		return count
	}
	// ⚠ NO `-c`. That flag is procps', and the hosts that reach this fallback are
	// exactly the ones without procps: BSD pgrep (macOS) has no `-c` and exits 2
	// with a usage error, which this function then read as "zero processes". So on
	// every Mac the count was silently always 0 — measured with 21 codex processes
	// running. One pid per line is what both implementations print by default, so
	// counting lines works on both.
	result := sys.Run(ctx, "pgrep", []string{"-x", name},
		sys.Options{TimeoutMs: boundMs(options.TimeoutMs, defaultProcessTimeoutMs)})
	// pgrep exits 1 with no output when nothing matched: an answer, not a failure.
	// Any other non-zero is a broken invocation, and 0 is the honest answer for it.
	if result.Code != 0 {
		return 0
	}
	count := 0
	for _, line := range strings.Split(result.Stdout, "\n") {
		if isPID(strings.TrimSpace(line)) {
			count++
		}
	}
	if count > math.MaxInt32 {
		return math.MaxInt32
	}
	return count
}

// isPID keeps the numeric entries of /proc: everything else there (`self`, `net`,
// `sys`, …) is not a process.
func isPID(name string) bool {
	if name == "" {
		return false
	}
	for _, char := range name {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}
