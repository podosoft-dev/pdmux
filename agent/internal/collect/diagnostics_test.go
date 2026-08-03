package collect

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// probes is a collector plus the counters that prove how often it looked at the
// host — the whole design of diagnostics.go is "no new probe per beat", and a
// count is the only way to assert that.
type probes struct {
	collector   *DiagnosticsCollector
	ptyCalls    int
	binaryCalls int
	now         int64
}

func newProbes(ptyFallback, gitPresent bool) *probes {
	p := &probes{now: 1_785_000_000}
	p.collector = NewDiagnosticsCollector(DiagnosticsOptions{
		Now: func() int64 { return p.now },
		PTYFallback: func(context.Context) bool {
			p.ptyCalls++
			return ptyFallback
		},
		HasBinary: func(string) bool {
			p.binaryCalls++
			return gitPresent
		},
	})
	return p
}

func (p *probes) tick(seconds int64) { p.now += seconds }

func testConfig(gitRoots, usageProviders []string) protocol.AgentConfig {
	config := protocol.NewAgentConfig()
	if gitRoots != nil {
		config.GitRoots = gitRoots
	}
	if usageProviders != nil {
		config.UsageProviders = usageProviders
	}
	return config
}

func codesOf(entries []protocol.AgentDiagnostic) []string {
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		out = append(out, entry.Code)
	}
	return out
}

func TestDiagnostics(t *testing.T) {
	t.Run("[TC-PDAGENT-043] says nothing when the host is healthy", func(t *testing.T) {
		p := newProbes(false, true)
		p.collector.NoteMux(true)
		p.collector.NoteGitRoots(nil)
		p.collector.NoteLedger(false)
		p.collector.NoteUsage(nil)
		if got := p.collector.Collect(t.Context(), testConfig(nil, nil)); len(got) != 0 {
			t.Fatalf("diagnostics = %v, want none", got)
		}
	})

	t.Run("[TC-PDAGENT-043] reports the PTY fallback as information, not a failure", func(t *testing.T) {
		p := newProbes(true, true)
		got := p.collector.Collect(t.Context(), testConfig(nil, nil))
		if len(got) != 1 || got[0].Code != CodePTYFallback || got[0].Level != protocol.DiagnosticInfo {
			t.Fatalf("diagnostics = %+v, want one info-level pty.fallback", got)
		}
	})

	t.Run("[TC-PDAGENT-043] escalates a missing git only when roots were configured", func(t *testing.T) {
		idle := newProbes(false, false).collector.Collect(t.Context(), testConfig(nil, nil))
		if len(idle) != 1 || idle[0].Code != CodeGitMissing || idle[0].Level != protocol.DiagnosticWarn {
			t.Fatalf("with no roots = %+v, want a warning", idle)
		}
		// A configured root means somebody asked for this feature and it cannot
		// work at all — that is an error, not a latent one.
		asked := newProbes(false, false).collector.Collect(t.Context(), testConfig([]string{"/srv/work"}, nil))
		if len(asked) != 1 || asked[0].Level != protocol.DiagnosticError {
			t.Fatalf("with a root = %+v, want an error", asked)
		}
	})

	t.Run("[TC-PDAGENT-043] reports a missing multiplexer, an unwritable state dir and silent providers", func(t *testing.T) {
		p := newProbes(false, true)
		p.collector.NoteMux(false)
		p.collector.NoteLedger(true)
		p.collector.NoteUsage([]string{"codex"})
		codes := codesOf(p.collector.Collect(t.Context(), testConfig(nil, []string{"claude", "codex"})))
		for _, want := range []string{CodeMuxMissing, CodeStateUnwritable, CodeUsageUnavailable} {
			if !slices.Contains(codes, want) {
				t.Fatalf("codes = %v, want %q", codes, want)
			}
		}
	})

	t.Run("[TC-PDAGENT-043] reports configured roots that are not checkouts", func(t *testing.T) {
		p := newProbes(false, true)
		p.collector.NoteGitRoots([]string{"/srv/typo"})
		got := p.collector.Collect(t.Context(), testConfig([]string{"/srv/work", "/srv/typo"}, nil))
		if len(got) != 1 || got[0].Code != CodeGitRootMissing || got[0].Level != protocol.DiagnosticWarn {
			t.Fatalf("diagnostics = %+v", got)
		}
		if !strings.Contains(got[0].Message, "/srv/typo") {
			t.Fatalf("message = %q, want the root named", got[0].Message)
		}
	})

	t.Run("[TC-PDAGENT-043] emits frames the contract accepts", func(t *testing.T) {
		p := newProbes(true, false)
		p.collector.NoteMux(false)
		p.collector.NoteLedger(true)
		p.collector.NoteGitRoots([]string{"/srv/typo"})
		p.collector.NoteUsage([]string{"codex"})
		got := p.collector.Collect(t.Context(), testConfig([]string{"/srv/typo"}, []string{"codex"}))
		if len(got) != 6 {
			t.Fatalf("diagnostics = %v, want all six codes", codesOf(got))
		}
		// The contract is the judge, not this test's opinion of it: the same
		// bytes the agent would send are validated against the embedded schema.
		heartbeat := protocol.NewHeartbeat()
		heartbeat.Ts = 1_785_000_000
		heartbeat.Diagnostics = got
		if _, err := protocol.EncodeUpstream(&protocol.HeartbeatFrame{Heartbeat: heartbeat}); err != nil {
			t.Fatalf("diagnostics rejected by the contract: %v", err)
		}
	})
}

func TestDiagnosticStability(t *testing.T) {
	t.Run("[TC-PDAGENT-044] returns the same list, in the same order, between beats", func(t *testing.T) {
		p := newProbes(true, false)
		p.collector.NoteMux(false)
		p.collector.NoteLedger(true)
		first := p.collector.Collect(t.Context(), testConfig(nil, nil))
		p.tick(5)
		second := p.collector.Collect(t.Context(), testConfig(nil, nil))
		if fmt.Sprint(first) != fmt.Sprint(second) {
			t.Fatalf("beats disagree:\n%v\n%v", first, second)
		}
		// Errors first, then warnings, then information — never insertion order,
		// and alphabetical by code within a level.
		wantCodes := []string{CodeGitMissing, CodeMuxMissing, CodeStateUnwritable, CodePTYFallback}
		if got := codesOf(first); fmt.Sprint(got) != fmt.Sprint(wantCodes) {
			t.Fatalf("codes = %v, want %v", got, wantCodes)
		}
		wantLevels := []protocol.DiagnosticLevel{
			protocol.DiagnosticWarn, protocol.DiagnosticWarn, protocol.DiagnosticWarn, protocol.DiagnosticInfo,
		}
		for index, want := range wantLevels {
			if first[index].Level != want {
				t.Fatalf("level[%d] = %q, want %q", index, first[index].Level, want)
			}
		}
	})

	t.Run("[TC-PDAGENT-044] drops an entry as soon as the condition clears", func(t *testing.T) {
		p := newProbes(false, true)
		p.collector.NoteMux(false)
		p.collector.NoteLedger(true)
		p.collector.NoteGitRoots([]string{"/srv/typo"})
		if got := p.collector.Collect(t.Context(), testConfig([]string{"/srv/typo"}, nil)); len(got) != 3 {
			t.Fatalf("diagnostics = %v, want three", codesOf(got))
		}

		p.collector.NoteMux(true)
		p.collector.NoteLedger(false)
		p.collector.NoteGitRoots(nil)
		p.tick(1)
		if got := p.collector.Collect(t.Context(), testConfig([]string{"/srv/typo"}, nil)); len(got) != 0 {
			t.Fatalf("diagnostics = %v, want none once the conditions cleared", codesOf(got))
		}
	})

	t.Run("[TC-PDAGENT-044] forgets observations about roots that are no longer configured", func(t *testing.T) {
		p := newProbes(false, true)
		p.collector.NoteGitRoots([]string{"/srv/old"})
		// The root was dropped from the configuration; naming it now would report
		// a problem with something nobody asked for any more.
		if got := p.collector.Collect(t.Context(), testConfig([]string{"/srv/new"}, nil)); len(got) != 0 {
			t.Fatalf("diagnostics = %v", codesOf(got))
		}
		p.collector.Reset()
		if got := p.collector.Collect(t.Context(), testConfig([]string{"/srv/new"}, nil)); len(got) != 0 {
			t.Fatalf("after reset = %v", codesOf(got))
		}
	})

	t.Run("[TC-PDAGENT-044] makes no claim before a git pass has run", func(t *testing.T) {
		p := newProbes(false, true)
		if got := p.collector.Collect(t.Context(), testConfig([]string{"/srv/work"}, nil)); len(got) != 0 {
			t.Fatalf("diagnostics = %v — no evidence, no claim", codesOf(got))
		}
	})
}

func TestDiagnosticPrivacy(t *testing.T) {
	t.Run("[TC-PDAGENT-045] names only values the server itself configured", func(t *testing.T) {
		p := newProbes(true, false)
		p.collector.NoteMux(false)
		p.collector.NoteLedger(true)
		p.collector.NoteGitRoots([]string{"/srv/work", "/home/alice/secret-checkout"})
		p.collector.NoteUsage([]string{"codex", "private-cli"})
		entries := p.collector.Collect(t.Context(), testConfig([]string{"/srv/work"}, []string{"codex"}))

		messages := make([]string, 0, len(entries))
		for _, entry := range entries {
			messages = append(messages, entry.Message)
		}
		text := strings.Join(messages, "\n")

		for _, want := range []string{"/srv/work", "codex"} {
			if !strings.Contains(text, want) {
				t.Fatalf("message set does not name %q:\n%s", want, text)
			}
		}
		// Observed but not configured -> never named, and these are rendered in a
		// browser that may belong to someone who cannot log into the host.
		for _, forbidden := range []string{"/home/alice/secret-checkout", "private-cli"} {
			if strings.Contains(text, forbidden) {
				t.Fatalf("message set leaked %q:\n%s", forbidden, text)
			}
		}
		// The state directory carries a username, so it is never in the message.
		for _, pattern := range []string{`/home/`, `/var/lib/pdmux`, `\.local/state`, `(?i)token|api[-_]?key`} {
			if regexp.MustCompile(pattern).MatchString(text) {
				t.Fatalf("message set matched %q:\n%s", pattern, text)
			}
		}
	})

	t.Run("[TC-PDAGENT-045] keeps a message inside the contract length", func(t *testing.T) {
		roots := make([]string, 0, 60)
		for index := range 60 {
			roots = append(roots, fmt.Sprintf("/srv/root-%03d", index))
		}
		message := joinNames("Configured git root is missing or not a checkout: ", roots, maxDiagnosticMessage)
		if len([]rune(message)) > maxDiagnosticMessage {
			t.Fatalf("message is %d chars, cap is %d", len([]rune(message)), maxDiagnosticMessage)
		}
		// A truncated list that does not say it is truncated reads as complete.
		if !regexp.MustCompile(`\(\+\d+ more\)$`).MatchString(message) {
			t.Fatalf("message does not say how many it left out: %q", message)
		}

		entry := protocol.NewAgentDiagnostic()
		entry.Level = protocol.DiagnosticWarn
		entry.Code = CodeGitRootMissing
		entry.Message = message
		heartbeat := protocol.NewHeartbeat()
		heartbeat.Ts = 1_785_000_000
		heartbeat.Diagnostics = []protocol.AgentDiagnostic{entry}
		if _, err := protocol.EncodeUpstream(&protocol.HeartbeatFrame{Heartbeat: heartbeat}); err != nil {
			t.Fatalf("capped message rejected by the contract: %v", err)
		}
	})

	t.Run("[TC-PDAGENT-045] sorts names so the same set always renders identically", func(t *testing.T) {
		if joinNames("roots: ", []string{"/b", "/a"}, maxDiagnosticMessage) !=
			joinNames("roots: ", []string{"/a", "/b"}, maxDiagnosticMessage) {
			t.Fatal("the same set rendered two ways — the card would flap between beats")
		}
	})
}

func TestDiagnosticsOnHeartbeat(t *testing.T) {
	t.Run("[TC-PDAGENT-046] travels with the heartbeat and adds no probe per beat", func(t *testing.T) {
		p := newProbes(true, false)
		deps := Deps{
			Resource:    quietReaders(),
			Sessions:    func(context.Context) SessionReading { return SessionReading{Sessions: []protocol.MuxSession{}} },
			Diagnostics: p.collector,
			Now:         func() int64 { return 1_785_000_000 },
		}

		first := Heartbeat(t.Context(), testConfig(nil, nil), deps)
		wantCodes := []string{CodeGitMissing, CodeMuxMissing, CodePTYFallback}
		if got := codesOf(first.Diagnostics); fmt.Sprint(got) != fmt.Sprint(wantCodes) {
			t.Fatalf("codes = %v, want %v", got, wantCodes)
		}

		for range 5 {
			p.tick(5)
			next := Heartbeat(t.Context(), testConfig(nil, nil), deps)
			if fmt.Sprint(next.Diagnostics) != fmt.Sprint(first.Diagnostics) {
				t.Fatalf("beat drifted:\n%v\n%v", first.Diagnostics, next.Diagnostics)
			}
		}
		// Six beats, one lookup each — the rest came from what the pass already knew.
		if p.ptyCalls != 1 || p.binaryCalls != 1 {
			t.Fatalf("lookups = %d pty / %d binary after six beats, want 1 each", p.ptyCalls, p.binaryCalls)
		}

		// Past the cache window the facts are re-checked, so a host somebody just
		// fixed recovers without a restart.
		p.tick(120)
		Heartbeat(t.Context(), testConfig(nil, nil), deps)
		if p.binaryCalls != 2 {
			t.Fatalf("binary lookups = %d after the TTL expired, want 2", p.binaryCalls)
		}
	})

	t.Run("[TC-PDAGENT-046] reports no diagnostics when nothing collects them", func(t *testing.T) {
		got := Heartbeat(t.Context(), testConfig(nil, nil), Deps{
			Resource: quietReaders(),
			Sessions: func(context.Context) SessionReading {
				return SessionReading{Sessions: []protocol.MuxSession{}, Present: true}
			},
		})
		if got.Diagnostics == nil || len(got.Diagnostics) != 0 {
			t.Fatalf("diagnostics = %v, want an empty (non-nil) list", got.Diagnostics)
		}
	})
}
