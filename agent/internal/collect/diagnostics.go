package collect

// Degraded capabilities, reported IN BAND on the heartbeat.
//
// WHY IN BAND: every condition below was already detectable — by running
// `pdmux-agent doctor` on the host. Nobody runs it until they already suspect a
// problem, so "sessions are always empty" or "the repo panel never fills in"
// looked like a dashboard bug for as long as it took someone to ssh in. On the
// card it is visible before anyone asks.
//
// WHERE THE FACTS COME FROM: all six are things the agent already knows. The
// session read tells us whether a multiplexer exists, the git pass tells us
// which configured roots yielded nothing, the ledger store knows whether it can
// write, the usage collector knows which providers said nothing. Only the PTY
// mode and the git binary are LOOKED UP here — once per TTL, then cached —
// because the heartbeat runs every few seconds and must not grow a probe per
// beat. They are the two that can also change under a running agent (somebody
// installs git), which is why they are cached rather than resolved once and
// frozen.
//
// ⚠ WHAT MAY GO IN A MESSAGE: only values the SERVER gave us (a configured git
// root, a configured provider id). Never a credential, never a local path the
// server did not choose (the state directory contains a username), never a
// hostname. These strings are rendered in a browser that may belong to someone
// who cannot log into the host.
//
// Ported from apps/agent/src/collect/diagnostics.ts.

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/sys"
)

// DiagnosticTTLSec is how long a looked-up fact is trusted.
const DiagnosticTTLSec = 60

// Stable codes. A UI translates these; `message` is only the fallback text.
const (
	CodePTYFallback      = "pty.fallback"
	CodeGitMissing       = "git.missing"
	CodeMuxMissing       = "mux.missing"
	CodeStateUnwritable  = "state.unwritable"
	CodeGitRootMissing   = "git.root_missing"
	CodeUsageUnavailable = "usage.unavailable"
	// Listening ports could not be read at all — which is a different claim from
	// "this host has none", and the two must not render as the same empty table.
	CodeListenersUnavailable = "listeners.unavailable"
	// More ports than the contract carries. Without this the table shows a full
	// list and nothing says it is not the whole one.
	CodeListenersTruncated = "listeners.truncated"
)

// maxDiagnosticMessage is agentDiagnostic.message's maxLength in the contract. A
// host with forty broken roots must not push a 4KB string per heartbeat — and a
// message one character over it would cost the entire frame.
const maxDiagnosticMessage = 512

// levelOrder sorts by severity first. The values are the TypeScript's table.
var levelOrder = map[protocol.DiagnosticLevel]int{
	protocol.DiagnosticError: 0,
	protocol.DiagnosticWarn:  1,
	protocol.DiagnosticInfo:  2,
}

// PTYFallbackFunc reports whether the terminal is running in a degraded mode.
//
// WHY THIS IS A SEAM AND NOT A CALL INTO internal/term: the condition it reports
// is defined by whatever the terminal implementation can and cannot do, and in
// Go a PTY is a platform syscall rather than an optional native module — so
// unlike the Node agent (where a missing node-pty meant the script(1) fallback),
// there is nothing here to detect by default. The wiring layer injects the real
// probe if the terminal ever grows a degraded mode; until it does, the honest
// default is "not degraded", and the code stays alive because the contract and
// the UI both know it.
type PTYFallbackFunc func(ctx context.Context) bool

// DiagnosticsOptions are the injectable parts of a collector. A zero value gives
// the real host lookups and the default TTL.
type DiagnosticsOptions struct {
	TTLSec      int
	Now         func() int64
	PTYFallback PTYFallbackFunc
	// HasBinary answers "is this on PATH". The default is a PATH lookup rather
	// than the TypeScript's `which` child process: same answer, and the point of
	// this file is not to add work to a pass that runs every few seconds.
	HasBinary func(name string) bool
}

// DiagnosticsCollector is a VIEW over facts the agent already has, plus two
// cached lookups.
//
// The mutex is not in the TypeScript, which ran on one event loop. Here the git
// pass, the usage pass and the heartbeat are separate goroutines and all four
// Note* methods are called from whichever one learned the fact, so the state
// they write is genuinely shared.
type DiagnosticsCollector struct {
	mu sync.Mutex

	// nil means "no evidence yet", which is different from false: before a
	// session read has happened this collector must make no claim. The same
	// applies to missingRoots, where an empty (or nil) list names nothing.
	muxPresent        *bool
	missingRoots      []string
	ledgerUnavailable bool
	usageUnavailable  []string
	listenersOK       *bool
	listenersDropped  int

	ptyFallback *bool
	gitPresent  *bool
	probedAt    int64

	ttlSec           int64
	now              func() int64
	ptyFallbackProbe PTYFallbackFunc
	hasBinary        func(name string) bool
}

// NewDiagnosticsCollector builds a collector, filling in the host lookups for
// anything omitted.
func NewDiagnosticsCollector(options DiagnosticsOptions) *DiagnosticsCollector {
	collector := &DiagnosticsCollector{
		ttlSec:           int64(options.TTLSec),
		now:              options.Now,
		ptyFallbackProbe: options.PTYFallback,
		hasBinary:        options.HasBinary,
	}
	if collector.ttlSec <= 0 {
		collector.ttlSec = DiagnosticTTLSec
	}
	if collector.now == nil {
		collector.now = nowSeconds
	}
	if collector.ptyFallbackProbe == nil {
		collector.ptyFallbackProbe = func(context.Context) bool { return false }
	}
	if collector.hasBinary == nil {
		collector.hasBinary = func(name string) bool {
			_, found := sys.Which(name)
			return found
		}
	}
	return collector
}

// NoteMux records the session read the heartbeat already performs.
func (d *DiagnosticsCollector) NoteMux(present bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.muxPresent = ptr(present)
}

// NoteGitRoots records the configured roots the git pass found unusable.
func (d *DiagnosticsCollector) NoteGitRoots(missing []string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.missingRoots = slices.Clone(missing)
}

// NoteLedger records whether the state directory can be written.
func (d *DiagnosticsCollector) NoteLedger(unavailable bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ledgerUnavailable = unavailable
}

// NoteUsage records providers that were configured and reported nothing.
func (d *DiagnosticsCollector) NoteUsage(unavailable []string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.usageUnavailable = slices.Clone(unavailable)
}

// NoteListeners records the port reading the heartbeat already performed.
func (d *DiagnosticsCollector) NoteListeners(reading ListenerReading) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.listenersOK = ptr(reading.Supported)
	d.listenersDropped = reading.Dropped
}

// Reset drops past observations after a configuration change large enough that
// they no longer describe what the server asked for.
func (d *DiagnosticsCollector) Reset() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.missingRoots = nil
	d.usageUnavailable = nil
}

// Collect renders the current diagnostics. It never looks at the host except
// through refreshProbes, which is bounded by the TTL.
func (d *DiagnosticsCollector) Collect(ctx context.Context, config protocol.AgentConfig) []protocol.AgentDiagnostic {
	d.refreshProbes(ctx)

	d.mu.Lock()
	defer d.mu.Unlock()

	out := []protocol.AgentDiagnostic{}
	add := func(level protocol.DiagnosticLevel, code, message string) {
		entry := protocol.NewAgentDiagnostic()
		entry.Level = level
		entry.Code = code
		entry.Message = message
		out = append(out, entry)
	}

	if isTrue(d.ptyFallback) {
		add(protocol.DiagnosticInfo, CodePTYFallback,
			"PTY uses the script(1) fallback; resize is applied out of band and is unavailable without /proc.")
	}
	if isFalse(d.gitPresent) {
		// A configured root means somebody asked for this feature and it cannot
		// work at all; without roots it is only a latent problem.
		level := protocol.DiagnosticWarn
		if len(config.GitRoots) > 0 {
			level = protocol.DiagnosticError
		}
		add(level, CodeGitMissing, "git is not installed; repository snapshots are skipped.")
	}
	if isFalse(d.muxPresent) {
		add(protocol.DiagnosticWarn, CodeMuxMissing,
			"No multiplexer found; no sessions are listed and session terminals cannot be opened.")
	}
	if d.ledgerUnavailable {
		// Deliberately no path: the state directory contains a username.
		add(protocol.DiagnosticWarn, CodeStateUnwritable,
			"State directory is not writable; commit details are rebuilt after every restart.")
	}
	// Only roots the server itself configured are named.
	if missing := configured(d.missingRoots, config.GitRoots); len(missing) > 0 {
		add(protocol.DiagnosticWarn, CodeGitRootMissing,
			joinNames("Configured git root is missing or not a checkout: ", missing, maxDiagnosticMessage))
	}
	if isFalse(d.listenersOK) {
		// No tool named: the message is read by somebody who may not be able to log
		// into the host, and "install lsof" is advice only an operator can act on.
		add(protocol.DiagnosticInfo, CodeListenersUnavailable,
			"Listening ports cannot be read on this host; the discovered-port list is empty for that reason, not because nothing is listening.")
	}
	if d.listenersDropped > 0 {
		add(protocol.DiagnosticWarn, CodeListenersTruncated,
			fmt.Sprintf("Too many listening ports to report; %d are missing from the list.", d.listenersDropped))
	}
	if silent := configured(d.usageUnavailable, config.UsageProviders); len(silent) > 0 {
		add(protocol.DiagnosticWarn, CodeUsageUnavailable,
			joinNames("Configured usage provider reported nothing: ", silent, maxDiagnosticMessage))
	}

	// Deterministic order — a card that reshuffles its badges every beat reads as
	// flapping even when nothing changed.
	slices.SortFunc(out, func(a, b protocol.AgentDiagnostic) int {
		if order := levelOrder[a.Level] - levelOrder[b.Level]; order != 0 {
			return order
		}
		return strings.Compare(a.Code, b.Code)
	})
	return out
}

// refreshProbes looks up the only two facts that are not already known, at most
// once per TTL.
//
// Two passes overlapping would probe twice — harmless (both lookups are reads,
// and they agree), and the alternative is holding the lock across a call that
// can block, which would stall the Note* methods the other passes use.
func (d *DiagnosticsCollector) refreshProbes(ctx context.Context) {
	d.mu.Lock()
	now := d.now()
	if d.probedAt != 0 && now-d.probedAt < d.ttlSec {
		d.mu.Unlock()
		return
	}
	d.probedAt = now
	probePTY, probeBinary := d.ptyFallbackProbe, d.hasBinary
	d.mu.Unlock()

	// Probed OUTSIDE the lock: a lookup can block (PATH on a network filesystem),
	// and holding the lock through it would stall every Note* call the other
	// passes make.
	fallback := probePTY(ctx)
	present := probeBinary("git")

	d.mu.Lock()
	defer d.mu.Unlock()
	d.ptyFallback = ptr(fallback)
	d.gitPresent = ptr(present)
}

// configured keeps only the names the server itself asked for. An observation
// about something no longer in the configuration describes a problem with
// nothing anybody wants.
func configured(observed, wanted []string) []string {
	out := make([]string, 0, len(observed))
	for _, name := range observed {
		if slices.Contains(wanted, name) {
			out = append(out, name)
		}
	}
	return out
}

// joinNames joins names into a message without ever exceeding the contract's
// length, and says how many it left out.
//
// The count is in RUNES rather than bytes: maxLength counts characters, so a
// byte budget would reject a legal message (or, worse, cut a rune in half).
func joinNames(prefix string, names []string, max int) string {
	sorted := slices.Clone(names)
	slices.Sort(sorted)

	out := prefix + strings.Join(sorted, ", ")
	if utf8.RuneCountInString(out) <= max {
		return out
	}

	kept := make([]string, 0, len(sorted))
	for _, name := range sorted {
		joined := name
		if len(kept) > 0 {
			joined = strings.Join(kept, ", ") + ", " + name
		}
		candidate := fmt.Sprintf("%s%s (+%d more)", prefix, joined, len(sorted)-len(kept)-1)
		if utf8.RuneCountInString(candidate) > max {
			break
		}
		kept = append(kept, name)
	}
	// The final clip covers the case where even one name does not fit: the
	// message then says only how many there were, truncated to the cap.
	return truncateRunes(fmt.Sprintf("%s%s (+%d more)", prefix, strings.Join(kept, ", "), len(sorted)-len(kept)), max)
}

func isTrue(value *bool) bool  { return value != nil && *value }
func isFalse(value *bool) bool { return value != nil && !*value }
