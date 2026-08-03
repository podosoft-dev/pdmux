package collect

// Service probes for the ports the server registered.
//
// WHY THE TIMEOUT IS SHORT AND HARD: probes run inside the heartbeat pass, and a
// host with a dozen services where one port blackholes SYN packets would spend a
// minute per pass with the OS default. A probe that did not answer in time is
// `down` for this pass, and the next pass asks again.
//
// Ported from apps/agent/src/collect/probe.ts.

import (
	"context"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// DefaultProbeTimeoutMs is used when the server's config carries no bound.
const DefaultProbeTimeoutMs = 2_000

// probeHost is deliberately the loopback address and not a name: the agent
// probes services ON THIS HOST, and resolving "localhost" would add a DNS
// timeout to a call whose entire purpose is to be bounded.
const probeHost = "127.0.0.1"

// ProbeResult is one measurement of one port.
type ProbeResult struct {
	Status protocol.ProbeStatus
	// LatencyMs is nil for anything but `up`: there is no latency to report for a
	// connection that never happened, and 0 would read as "instant".
	LatencyMs *int
}

// probeTransport is shared, and keep-alives are off on purpose. A probe measures
// "can something be reached right now", so reusing a socket from the previous
// beat would report a latency that no longer proves anything — and would hold a
// connection open against a service the operator is only watching.
var probeTransport = &http.Transport{DisableKeepAlives: true}

// ProbeTCP reports whether a TCP connection to the port completes.
func ProbeTCP(ctx context.Context, port int, timeoutMs int) ProbeResult {
	timeout := time.Duration(boundMs(timeoutMs, DefaultProbeTimeoutMs)) * time.Millisecond
	started := time.Now()
	dialer := net.Dialer{Timeout: timeout}
	conn, err := dialer.DialContext(ctx, "tcp", address(port))
	if err != nil {
		return ProbeResult{Status: protocol.ProbeDown}
	}
	elapsed := time.Since(started)
	_ = conn.Close()
	return ProbeResult{Status: protocol.ProbeUp, LatencyMs: ptr(latencyMs(elapsed))}
}

// ProbeHTTP asks the port for one page.
func ProbeHTTP(ctx context.Context, port int, path string, timeoutMs int) ProbeResult {
	timeout := time.Duration(boundMs(timeoutMs, DefaultProbeTimeoutMs)) * time.Millisecond
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, "http://"+address(port)+normalisePath(path), nil)
	if err != nil {
		// A path the server configured is not a URL. Nothing to probe, and the
		// next pass will not do better — `down` is what the TypeScript's failed
		// request produced too.
		return ProbeResult{Status: protocol.ProbeDown}
	}

	// The bound lives on the request context alone: one timeout, which also
	// carries the caller's cancellation when the agent is shutting down.
	started := time.Now()
	client := &http.Client{
		Transport: probeTransport,
		// Do not follow redirects. The first answer is the proof we came for, and
		// following one would let a service's own 302 send this probe at a host
		// nobody registered.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	response, err := client.Do(request)
	if err != nil {
		return ProbeResult{Status: protocol.ProbeDown}
	}
	elapsed := time.Since(started)
	_ = response.Body.Close()

	// Any answer proves the port is served. A 404 from a dev server that has no
	// `/` route still means the service is up, so only a 5xx (the process itself
	// failing) counts as down.
	if response.StatusCode >= 500 {
		return ProbeResult{Status: protocol.ProbeDown}
	}
	return ProbeResult{Status: protocol.ProbeUp, LatencyMs: ptr(latencyMs(elapsed))}
}

// Service probes one registered service.
func Service(ctx context.Context, service protocol.AgentServiceConfig, timeoutMs int) protocol.ServiceProbe {
	out := protocol.NewServiceProbe()
	out.ID = service.ID

	// `none` is "not probed", which is a different statement from `down`: the
	// link is offerable, its answer is simply not guaranteed.
	if service.Probe == protocol.ProbeNone {
		out.Status = protocol.ProbeUnknown
		return out
	}

	var result ProbeResult
	if service.Probe == protocol.ProbeHTTP {
		result = ProbeHTTP(ctx, service.Port, service.Path, timeoutMs)
	} else {
		result = ProbeTCP(ctx, service.Port, timeoutMs)
	}
	out.Status = result.Status
	out.LatencyMs = result.LatencyMs
	return out
}

// Services probes every registered service in parallel, so the pass costs one
// timeout rather than one per service.
func Services(ctx context.Context, services []protocol.AgentServiceConfig, timeoutMs int) []protocol.ServiceProbe {
	out := make([]protocol.ServiceProbe, len(services))
	var wg sync.WaitGroup
	for index, service := range services {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// A panic in a goroutine takes down the process, not just the caller —
			// so the recovery has to live inside the goroutine. An unmeasurable
			// service is `unknown`, and the rest of the heartbeat still ships.
			defer func() {
				if recover() != nil {
					failed := protocol.NewServiceProbe()
					failed.ID = service.ID
					failed.Status = protocol.ProbeUnknown
					out[index] = failed
				}
			}()
			out[index] = Service(ctx, service, timeoutMs)
		}()
	}
	wg.Wait()
	return out
}

func address(port int) string {
	return net.JoinHostPort(probeHost, strconv.Itoa(port))
}

// normalisePath keeps the request line well-formed. The contract only caps the
// length of a service path, so a configured "health" (no slash) has to become
// "/health" here rather than produce a URL that means something else.
func normalisePath(path string) string {
	if path == "" {
		return "/"
	}
	if path[0] != '/' {
		return "/" + path
	}
	return path
}

// latencyMs truncates to whole milliseconds, which is the contract's unit and
// all the resolution a card shows. A sub-millisecond answer reports 0 — the one
// place in this package where 0 is a measurement rather than a missing one.
func latencyMs(elapsed time.Duration) int {
	if elapsed < 0 {
		return 0
	}
	return int(elapsed.Milliseconds())
}
