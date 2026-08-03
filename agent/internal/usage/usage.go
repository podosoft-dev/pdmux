// Package usage measures how much of each coding CLI's budget is left on this
// host, and how many of them are running.
//
// THE PLUGIN SEAM IS THE POINT: every CLI exposes its remaining budget
// differently — one only ever writes it into a statusline payload, the next
// answers a JSON-RPC call, the one after that will do something else again. The
// core must stay provider-neutral, so those differences live behind Provider's
// three members and nowhere else. A provider is identified by its CLI binary
// name, and registry.go is the only file here allowed to know a vendor exists.
//
// TWO RULES SHAPE EVERYTHING ELSE:
//
//  1. A ROW OF ZEROS IS WORSE THAN NO ROW. Reporting 0 processes and no windows
//     for a CLI that is not installed is data that looks measured and is not —
//     the card draws an empty gauge for a budget that does not exist.
//  2. READING USAGE IS EXPENSIVE. A budget read can mean spawning the CLI, so it
//     runs on its own clock (CachedCollector) rather than on the heartbeat's. A
//     cached row keeps the `ts` of the pass that produced it, so the UI dims a
//     stale snapshot instead of hiding it.
//
// Ported from apps/agent/src/usage/types.ts.
package usage

import (
	"context"
	"slices"
	"sync"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/log"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// DefaultTTLSec matches agentConfig.usageIntervalSec's own default; the server
// overrides it live with SetTTL.
const DefaultTTLSec = 60

// The contract's caps: heartbeat.usage is max(16) and agentUsage.windows is
// max(8). The server's own schema already caps usageProviders at 16, so this is
// defence in depth — but one element over either limit fails the array, then the
// whole heartbeat, and the host stops appearing on the dashboard entirely.
const (
	maxRows    = 16
	maxWindows = 8
)

// Provider is one coding CLI's adapter.
type Provider interface {
	// ID is a stable id, normally the CLI's binary name. Echoed to the server as-is.
	ID() string
	// ProcessCount is live processes of that CLI — exact process-name match, never
	// a cmdline grep.
	ProcessCount(ctx context.Context) int
	// Windows are remaining-budget windows, already normalised and expiry-filtered.
	Windows(ctx context.Context) []protocol.UsageWindow
}

// Collect asks every provider what it has. A provider contributes a row only
// when it has something to say.
func Collect(ctx context.Context, providers []Provider, now func() int64) []protocol.AgentUsage {
	return collectRows(ctx, providers, now, nil)
}

func collectRows(ctx context.Context, providers []Provider, now func() int64, logger *log.Logger) []protocol.AgentUsage {
	if now == nil {
		now = nowSeconds
	}
	rows := []protocol.AgentUsage{}
	for _, provider := range providers {
		if len(rows) >= maxRows {
			break
		}
		id := provider.ID()
		// The contract requires a non-empty provider id; a nameless row would fail
		// the whole heartbeat, so it costs itself instead.
		if id == "" {
			continue
		}
		processes, windows := readProvider(ctx, provider, id, logger)
		if processes == 0 && len(windows) == 0 {
			continue
		}
		if len(windows) > maxWindows {
			windows = windows[:maxWindows]
		}
		row := protocol.NewAgentUsage()
		row.Provider = id
		row.Processes = processes
		timestamp := now()
		row.Ts = &timestamp
		row.Windows = windows
		rows = append(rows, row)
	}
	return rows
}

// readProvider runs a provider's two reads in parallel, as Promise.all did: a
// budget read can spawn a CLI and take seconds, and counting processes has no
// reason to wait behind it.
//
// The recover is the Go shape of the TypeScript's `.catch(() => 0 / [])`. A
// panic escaping this package is already survivable (the heartbeat recovers its
// collectors), so this exists for a narrower reason: one broken adapter must cost
// its own row and not the rows of every provider after it in the list.
func readProvider(ctx context.Context, provider Provider, id string, logger *log.Logger) (int, []protocol.UsageWindow) {
	processes := 0
	windows := []protocol.UsageWindow{}

	var wg sync.WaitGroup
	run := func(what string, fn func()) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Deferred inside the goroutine, because a panic in a goroutine is not
			// recoverable by whoever started it — it takes the process with it.
			defer recoverRead(logger, id, what)
			fn()
		}()
	}
	run("processCount", func() { processes = provider.ProcessCount(ctx) })
	run("windows", func() {
		if reported := provider.Windows(ctx); reported != nil {
			windows = reported
		}
	})
	wg.Wait()

	// The contract's processes is a non-negative int; a negative one would fail the
	// frame, and "fewer than none running" is not a measurement anyone can act on.
	if processes < 0 {
		processes = 0
	}

	// ⚠ SAY SOMETHING WHEN A RUNNING CLI REPORTS NO BUDGET. Every failure inside this
	// package is deliberately indistinguishable from "no data" — not installed, wrong
	// version, timed out, snapshot elsewhere, all return an empty list. That silence is
	// right for the wire and wrong for the operator: it took a source read to discover
	// that a wrapper was writing the snapshot under the previous tool's name. Processes
	// running with no windows is the one combination that cannot be innocent, so it is
	// the one worth a line in the log — with the paths that were actually tried, which
	// is the fact that ends the search.
	if processes > 0 && len(windows) == 0 && logger != nil {
		fields := []log.Field{log.F("provider", id), log.F("processes", processes)}
		if snapshot, ok := provider.(*SnapshotFileProvider); ok {
			// The paths actually tried are the fact that ends the search.
			fields = append(fields, log.F("looked", snapshot.Paths()))
		}
		logger.Warn("Usage provider is running but reported no budget", fields...)
	}
	return processes, windows
}

func recoverRead(logger *log.Logger, id, what string) {
	panicked := recover()
	if panicked == nil || logger == nil {
		return
	}
	logger.Error("usage provider failed", log.F("provider", id), log.F("read", what), log.F("panic", panicked))
}

// CachedCollectorOptions configures a collector. A zero value collects nothing
// on the default TTL, which is what a host with no configured providers does.
type CachedCollectorOptions struct {
	Providers []Provider
	TTLSec    int
	Now       func() int64
	// Log is optional and used for exactly one thing: saying that a provider
	// panicked. The TypeScript swallowed the same class of failure silently, which
	// in a language where a panic means a bug would be one debugging session too many.
	Log *log.Logger
}

// CachedCollector reads usage on a slower clock than the heartbeat.
//
// WHY: a 5-second heartbeat that spawned a process per provider would cost more
// than everything else the agent does put together.
type CachedCollector struct {
	// The mutex is not in the TypeScript, which ran on one event loop. Here the
	// heartbeat calls Collect while the connection applies a new `config` through
	// SetProviders/SetTTL, so the state is genuinely shared.
	mu        sync.Mutex
	providers []Provider
	rows      []protocol.AgentUsage
	silent    []string
	lastAt    int64
	ttlSec    int64
	now       func() int64
	log       *log.Logger
}

// NewCachedCollector builds a collector over the given providers.
func NewCachedCollector(options CachedCollectorOptions) *CachedCollector {
	collector := &CachedCollector{
		providers: options.Providers,
		rows:      []protocol.AgentUsage{},
		silent:    []string{},
		ttlSec:    int64(options.TTLSec),
		now:       options.Now,
		log:       options.Log,
	}
	if collector.ttlSec <= 0 {
		collector.ttlSec = DefaultTTLSec
	}
	if collector.now == nil {
		collector.now = nowSeconds
	}
	return collector
}

// SetTTL adopts the server's `usageIntervalSec`, live.
func (c *CachedCollector) SetTTL(ttlSec int) {
	if ttlSec <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ttlSec = int64(ttlSec)
}

// TTL is the interval currently in force.
func (c *CachedCollector) TTL() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return int(c.ttlSec)
}

// SetProviders adopts a new provider set (the server may change it with
// `config`). A changed set drops the cache: rows for a provider nobody asked for
// any more would keep being reported until the TTL happened to expire.
func (c *CachedCollector) SetProviders(providers []Provider) {
	c.mu.Lock()
	defer c.mu.Unlock()
	changed := len(providers) != len(c.providers)
	if !changed {
		for index, provider := range providers {
			if provider.ID() != c.providers[index].ID() {
				changed = true
				break
			}
		}
	}
	c.providers = providers
	if changed {
		c.rows = []protocol.AgentUsage{}
		c.silent = []string{}
		c.lastAt = 0
	}
}

// Unavailable lists providers that were configured but produced nothing at the
// last refresh — the `usage.unavailable` diagnostic. Known for free: Collect
// already decided to omit their rows.
func (c *CachedCollector) Unavailable() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.silent)
}

// Collect returns the cached rows, refreshing them at most once per TTL.
func (c *CachedCollector) Collect(ctx context.Context) []protocol.AgentUsage {
	c.mu.Lock()
	now := c.now()
	if c.lastAt != 0 && now-c.lastAt < c.ttlSec {
		rows := c.rows
		c.mu.Unlock()
		return rows
	}
	// Stamped BEFORE the read, not after: the read can outlive the TTL, and a
	// second pass arriving meanwhile must serve the cached rows rather than start
	// a second set of child processes.
	c.lastAt = now
	providers, logger, clock := c.providers, c.log, c.now
	c.mu.Unlock()

	// Collected OUTSIDE the lock: this is the expensive call, and holding the lock
	// through it would block the connection's SetProviders and the heartbeat's
	// Unavailable for as long as a wedged CLI takes to die.
	rows := collectRows(ctx, providers, clock, logger)
	reporting := make(map[string]bool, len(rows))
	for _, row := range rows {
		// ⚠ A ROW IS NOT AN ANSWER. This used to be `reporting[row.Provider] = true`,
		// and that one line is why the reported defect was invisible: `claude` had five
		// live processes, so it got a row, so it counted as reporting — while its
		// windows were empty because the snapshot file was somewhere else entirely. The
		// card said "no budget reported" and nothing on the host or the wire disagreed.
		// A provider that is running but tells us nothing about its budget is exactly
		// the case the diagnostic exists for.
		if len(row.Windows) > 0 {
			reporting[row.Provider] = true
		}
	}
	silent := []string{}
	for _, provider := range providers {
		if id := provider.ID(); id != "" && !reporting[id] {
			silent = append(silent, id)
		}
	}
	// Sorted so the diagnostic message does not reshuffle between passes.
	slices.Sort(silent)

	c.mu.Lock()
	defer c.mu.Unlock()
	// Published by replacing the slice headers, never by mutating them: a caller
	// that already holds the previous rows is marshalling them onto the wire.
	c.rows, c.silent = rows, silent
	return rows
}

// nowSeconds is epoch seconds, the contract's unit for every timestamp.
func nowSeconds() int64 { return time.Now().Unix() }
