package usage

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/podosoft-dev/pdmux/agent/internal/collect"
	"github.com/podosoft-dev/pdmux/agent/internal/log"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// The seam the heartbeat expects, asserted at compile time: the collector is
// wired in by the agent's main loop, where a mismatch would be found later and
// with a worse error message.
var _ collect.UsageCollector = (*CachedCollector)(nil)

type stubProvider struct {
	id        string
	processes int
	windows   int
	panics    bool
	reads     atomic.Int32
}

func (s *stubProvider) ID() string { return s.id }

func (s *stubProvider) ProcessCount(context.Context) int {
	s.reads.Add(1)
	if s.panics {
		panic("boom")
	}
	return s.processes
}

func (s *stubProvider) Windows(context.Context) []protocol.UsageWindow {
	if s.panics {
		panic("boom")
	}
	out := []protocol.UsageWindow{}
	for range s.windows {
		window, _ := NormalizeWindow(RawWindow{
			Key: WindowSession, UsedPct: number(10), ResetsAt: number(float64(testNow + 60)),
		}, testNow)
		out = append(out, window)
	}
	return out
}

func fixedClock(value int64) func() int64 { return func() int64 { return value } }

func TestCollect(t *testing.T) {
	t.Run("[TC-PDAGENT-020] omits a provider that has nothing to report", func(t *testing.T) {
		// A row of zeros for a CLI that is not installed is data that looks measured
		// and is not — the card would draw an empty gauge for a budget that does not exist.
		rows := Collect(t.Context(), []Provider{
			&stubProvider{id: "absent"},
			&stubProvider{id: "live", processes: 2, windows: 1},
		}, fixedClock(testNow))
		if len(rows) != 1 || rows[0].Provider != "live" {
			t.Fatalf("rows = %+v, want only the live provider", rows)
		}
		if rows[0].Processes != 2 {
			t.Fatalf("processes = %d, want 2", rows[0].Processes)
		}
		if rows[0].Ts == nil || *rows[0].Ts != testNow {
			t.Fatalf("ts = %v, want %d — a cached row must be visibly older, not undated", rows[0].Ts, testNow)
		}
		if len(rows[0].Windows) != 1 {
			t.Fatalf("windows = %+v, want one", rows[0].Windows)
		}
	})

	t.Run("[TC-PDAGENT-020] survives a provider that throws", func(t *testing.T) {
		lines := &sync.Map{}
		logger := log.New(log.Options{Sink: func(line string) { lines.Store(line, true) }})
		rows := collectRows(t.Context(), []Provider{
			&stubProvider{id: "broken", panics: true},
			&stubProvider{id: "live", processes: 1},
		}, fixedClock(testNow), logger)
		if len(rows) != 1 || rows[0].Provider != "live" {
			t.Fatalf("rows = %+v, want the working provider's row", rows)
		}
		// A panic is a bug: silently swallowing it is how it survives to production.
		logged := false
		lines.Range(func(line, _ any) bool {
			if text, ok := line.(string); ok && strings.Contains(text, "usage provider failed") {
				logged = true
			}
			return !logged
		})
		if !logged {
			t.Fatal("a panicking provider was swallowed without a log line")
		}
	})

	t.Run("[TC-PDAGENT-020] caches rows so a fast heartbeat does not respawn a CLI", func(t *testing.T) {
		counting := &stubProvider{id: "counting", processes: 1}
		collector := NewCachedCollector(CachedCollectorOptions{
			Providers: []Provider{counting}, TTLSec: 60, Now: fixedClock(testNow),
		})
		collector.Collect(t.Context())
		collector.Collect(t.Context())
		if got := counting.reads.Load(); got != 1 {
			t.Fatalf("provider read %d times, want 1", got)
		}
	})

	t.Run("re-reads once the TTL has elapsed", func(t *testing.T) {
		counting := &stubProvider{id: "counting", processes: 1}
		clock := testNow
		collector := NewCachedCollector(CachedCollectorOptions{
			Providers: []Provider{counting}, TTLSec: 60, Now: func() int64 { return clock },
		})
		collector.Collect(t.Context())
		clock += 59
		collector.Collect(t.Context())
		if got := counting.reads.Load(); got != 1 {
			t.Fatalf("provider read %d times inside the TTL, want 1", got)
		}
		clock += 1
		collector.Collect(t.Context())
		if got := counting.reads.Load(); got != 2 {
			t.Fatalf("provider read %d times after the TTL, want 2", got)
		}
	})

	t.Run("adopts the server's interval and provider set", func(t *testing.T) {
		first := &stubProvider{id: "first", processes: 1}
		collector := NewCachedCollector(CachedCollectorOptions{
			Providers: []Provider{first}, Now: fixedClock(testNow),
		})
		if collector.TTL() != DefaultTTLSec {
			t.Fatalf("ttl = %d, want the default %d", collector.TTL(), DefaultTTLSec)
		}
		collector.SetTTL(30)
		collector.SetTTL(0) // a nonsensical interval is ignored, not adopted
		if collector.TTL() != 30 {
			t.Fatalf("ttl = %d, want 30", collector.TTL())
		}

		collector.Collect(t.Context())
		second := &stubProvider{id: "second", processes: 1}
		// A changed set drops the cache: rows for a provider nobody asked for any
		// more would otherwise be reported until the TTL happened to expire.
		collector.SetProviders([]Provider{second})
		rows := collector.Collect(t.Context())
		if len(rows) != 1 || rows[0].Provider != "second" {
			t.Fatalf("rows = %+v, want the new provider's row", rows)
		}
		if second.reads.Load() != 1 {
			t.Fatal("the new provider was never read")
		}
	})

	t.Run("names the configured providers that reported no budget", func(t *testing.T) {
		// ⚠ `running` IS UNAVAILABLE, AND THAT IS THE POINT. It has a live process, so it
		// gets a row — but its windows are empty, which means we learned nothing about its
		// budget. Counting a row as an answer is precisely why the reported defect was
		// invisible: `claude` had five processes and an empty gauge, the card said "no
		// budget reported", and the diagnostic that exists to name this case stayed silent
		// because a row had been emitted.
		collector := NewCachedCollector(CachedCollectorOptions{
			Providers: []Provider{
				&stubProvider{id: "zulu"},
				&stubProvider{id: "running", processes: 1},
				&stubProvider{id: "alpha"},
				&stubProvider{id: "reporting", processes: 1, windows: 1},
			},
			Now: fixedClock(testNow),
		})
		if got := collector.Unavailable(); len(got) != 0 {
			t.Fatalf("unavailable = %v before any pass, want none claimed", got)
		}
		collector.Collect(t.Context())
		got := collector.Unavailable()
		// Sorted: the diagnostic message must not reshuffle between beats.
		if len(got) != 3 || got[0] != "alpha" || got[1] != "running" || got[2] != "zulu" {
			t.Fatalf("unavailable = %v, want [alpha running zulu]", got)
		}
	})

	t.Run("cannot exceed the contract's caps on rows or windows", func(t *testing.T) {
		// One element over either cap fails the array, then the whole heartbeat, and
		// the host stops appearing on the dashboard at all.
		providers := []Provider{}
		for index := range maxRows + 4 {
			providers = append(providers, &stubProvider{
				id: string(rune('a'+index%26)) + string(rune('a'+index/26)), processes: 1, windows: maxWindows + 4,
			})
		}
		rows := Collect(t.Context(), providers, fixedClock(testNow))
		if len(rows) != maxRows {
			t.Fatalf("rows = %d, want the cap of %d", len(rows), maxRows)
		}
		for _, row := range rows {
			if len(row.Windows) != maxWindows {
				t.Fatalf("windows = %d, want the cap of %d", len(row.Windows), maxWindows)
			}
		}
	})

	t.Run("never produces a nil slice or a nameless row", func(t *testing.T) {
		rows := Collect(t.Context(), []Provider{&stubProvider{id: "", processes: 3}}, fixedClock(testNow))
		if rows == nil {
			t.Fatal("rows = nil, want an empty (non-nil) list")
		}
		if len(rows) != 0 {
			t.Fatalf("rows = %+v, want the id-less provider dropped", rows)
		}

		collector := NewCachedCollector(CachedCollectorOptions{Now: fixedClock(testNow)})
		if got := collector.Collect(t.Context()); got == nil {
			t.Fatal("collecting from no providers returned nil")
		}
	})
}
