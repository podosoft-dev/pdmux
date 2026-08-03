// Package collect turns one host into one heartbeat: CPU, memory and disk,
// multiplexer sessions, service probes, coding-agent usage, and the diagnostics
// that explain a host whose features are silently unavailable.
//
// TWO RULES RUN THROUGH EVERY FILE HERE, both from pdmux-work/docs/CONTRACTS.md C3:
//
//  1. A FAILED MEASUREMENT IS nil, NEVER 0. Zero draws an idle machine, and "this
//     host is healthy and idle" is the one thing an operator must not be told
//     when the truth is "we could not look". Every nullable value in this package
//     is therefore a pointer, and the only way to set one is to have measured it.
//
//  2. THE PASS NEVER FAILS AS A WHOLE. A collector that cannot measure
//     contributes its own nil/empty value and the rest of the heartbeat still
//     ships — an agent that goes silent because `df` hung looks exactly like a
//     host that went down, and the dashboard cannot tell the two apart.
//
// A third rule belongs to the wire rather than to the measurement: EVERY SLICE
// MUST MARSHAL AS `[]`. A nil Go slice marshals to `null`, which fails the
// element, then the array, then the whole frame — so the host stops appearing
// rather than appearing with an empty list.
//
// Ported from apps/agent/src/collect/*.
package collect

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/log"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// UsageCollector is the seam to the usage track (apps/agent/src/usage/types.ts's
// CachedUsageCollector). The heartbeat only ever needs these two: the rows, and
// which configured providers said nothing — the second is what feeds the
// `usage.unavailable` diagnostic, and it is known for free because the collector
// already decided to omit those rows.
type UsageCollector interface {
	Collect(ctx context.Context) []protocol.AgentUsage
	Unavailable() []string
}

// Deps are the collectors one pass runs. Every field is optional and a nil one
// means "this host does not report that" rather than an error — including
// Resource.CPU, whose absence is reported as an unmeasured CPU. Build the live
// set with NewDeps; a hand-built Deps is for specs.
type Deps struct {
	Resource ResourceReaders
	Sessions func(ctx context.Context) SessionReading
	// Listeners is the discovered-port reader. ⚠ WRAP IT IN NewCachedListeners:
	// the raw reader spawns a process on darwin and walks /proc/<pid>/fd on linux,
	// and this runs every few seconds. NewDeps does the wrapping.
	Listeners func(ctx context.Context) ListenerReading
	// Usage is nil on a host with no usage providers configured. ⚠ Assign a nil
	// *CachedUsageCollector into it and this is no longer nil — pass nothing, or
	// pass something that works.
	Usage       UsageCollector
	Diagnostics *DiagnosticsCollector
	Now         func() int64
	// Log is optional and is used for exactly one thing: saying that a collector
	// panicked. The TypeScript's `.catch(() => fallback)` swallowed the same class
	// of failure silently, which in a language where a panic means a bug rather
	// than a rejected promise would be one debugging session too many.
	Log *log.Logger
}

// NewDeps builds the default dependency set: a live CPU meter (which must
// survive across passes to have a delta at all) and the host readers for
// everything else.
func NewDeps(usage UsageCollector) Deps {
	return Deps{
		Resource: ResourceReaders{CPU: NewCPUMeter(CPUMeterOptions{})},
		Usage:    usage,
		Listeners: NewCachedListeners(func(ctx context.Context) ListenerReading {
			return ReadListeners(ctx, defaultListenerTimeoutMs)
		}, ListenerTTLSec, nil),
	}
}

// Heartbeat takes one pass over the host.
//
// The four collectors run in parallel, as they did behind Promise.all: a pass
// that ran them in sequence would cost the disk timeout plus the session timeout
// plus the slowest probe, which is more than the interval it is scheduled on.
func Heartbeat(ctx context.Context, config protocol.AgentConfig, deps Deps) protocol.Heartbeat {
	// Pre-seeded with exactly what a failed collector contributes, so a collector
	// that panics leaves the honest value behind rather than a zero one.
	resource := protocol.NewResource()
	// A failed read is not evidence that a multiplexer is absent — claiming
	// `mux.missing` because tmux timed out would put a badge on a healthy host.
	sessions := SessionReading{Sessions: []protocol.MuxSession{}, Present: true}
	services := []protocol.ServiceProbe{}
	usage := []protocol.AgentUsage{}
	// A collector that panicked has not proved the host cannot answer, so the
	// seed says "supported with nothing found" rather than raising the
	// `listeners.unavailable` badge on a host that has the tool.
	listeners := ListenerReading{Listeners: []protocol.Listener{}, Supported: true}

	var wg sync.WaitGroup
	run := func(name string, fn func()) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Inside the goroutine, because a panic in a goroutine is not
			// recoverable by whoever started it — it takes the process with it.
			defer deps.recoverCollector(name)
			fn()
		}()
	}

	readSessions := deps.sessionReader()
	run("resource", func() { resource = Resource(ctx, deps.Resource) })
	run("sessions", func() { sessions = readSessions(ctx) })
	run("services", func() { services = Services(ctx, config.Services, config.ProbeTimeoutMs) })
	run("usage", func() {
		if deps.Usage != nil {
			usage = deps.Usage.Collect(ctx)
		}
	})
	run("listeners", func() {
		if deps.Listeners != nil {
			listeners = deps.Listeners(ctx)
		}
	})
	wg.Wait()

	// Facts this pass just learned, handed to the diagnostics view before it
	// renders — it never takes a second look at the host.
	diagnostics := []protocol.AgentDiagnostic{}
	if deps.Diagnostics != nil {
		func() {
			defer deps.recoverCollector("diagnostics")
			deps.Diagnostics.NoteMux(sessions.Present)
			deps.Diagnostics.NoteListeners(listeners)
			if deps.Usage != nil {
				deps.Diagnostics.NoteUsage(deps.Usage.Unavailable())
			}
			diagnostics = deps.Diagnostics.Collect(ctx, config)
		}()
	}

	out := protocol.NewHeartbeat()
	out.Ts = deps.now()
	out.Resource = resource
	// nonNil on each: an injected collector may hand back a nil slice, and the
	// frame that carries it is rejected whole.
	out.Sessions = nonNil(sessions.Sessions)
	out.Usage = nonNil(usage)
	out.Services = nonNil(services)
	// Always set, never left nil: nil means "this agent does not report ports",
	// which is a claim only an older agent gets to make.
	reported := nonNil(listeners.Listeners)
	out.Listeners = &reported
	out.Diagnostics = nonNil(diagnostics)
	return out
}

func (d Deps) sessionReader() func(ctx context.Context) SessionReading {
	if d.Sessions != nil {
		return d.Sessions
	}
	return func(ctx context.Context) SessionReading { return ReadSessions(ctx, defaultSessionTimeoutMs) }
}

func (d Deps) now() int64 {
	if d.Now != nil {
		return d.Now()
	}
	return nowSeconds()
}

// recoverCollector is the Go shape of the TypeScript's per-collector `.catch()`.
// It must be deferred directly (`defer deps.recoverCollector(name)`) for recover
// to see the panic.
func (d Deps) recoverCollector(name string) {
	panicked := recover()
	if panicked == nil {
		return
	}
	if d.Log != nil {
		d.Log.Error("collector failed", log.F("collector", name), log.F("panic", fmt.Sprint(panicked)))
	}
}

// nowSeconds is epoch seconds, the contract's unit for every timestamp.
func nowSeconds() int64 { return time.Now().Unix() }

func nonNil[T any](values []T) []T {
	if values == nil {
		return []T{}
	}
	return values
}
