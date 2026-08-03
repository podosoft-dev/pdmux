package collect

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// A uuid, because serviceProbe.id is `format: uuid` in the contract and formats
// are asserted — an id the server cannot join back is worse than no probe.
const probeServiceID = "00000000-0000-4000-8000-000000000000"

// listeningPort opens a socket that accepts and immediately closes, which is all
// a TCP probe is entitled to assume about a service.
//
// Port 0 (kernel-assigned) rather than a fixture constant: Go runs packages in
// parallel, and the TypeScript suite had to disable file parallelism outright
// because specs sharing a fixture port produced failures nobody could reproduce.
// Hardcoding a port here brings that back.
func listeningPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listening: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()
	return listener.Addr().(*net.TCPAddr).Port
}

func httpPort(t *testing.T, status int) int {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte("no route here"))
	}))
	t.Cleanup(server.Close)
	_, portText, err := net.SplitHostPort(server.Listener.Addr().String())
	if err != nil {
		t.Fatalf("splitting %q: %v", server.Listener.Addr(), err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("port %q: %v", portText, err)
	}
	return port
}

func TestProbe(t *testing.T) {
	t.Run("[TC-PDAGENT-014] reports a listening port as up with a latency", func(t *testing.T) {
		got := ProbeTCP(t.Context(), listeningPort(t), 2_000)
		if got.Status != protocol.ProbeUp {
			t.Fatalf("status = %q, want up", got.Status)
		}
		if got.LatencyMs == nil || *got.LatencyMs < 0 {
			t.Fatalf("latency = %v, want a non-negative measurement", got.LatencyMs)
		}
	})

	t.Run("[TC-PDAGENT-014] reports a closed port as down without hanging", func(t *testing.T) {
		started := time.Now()
		got := ProbeTCP(t.Context(), 1, 500)
		if got.Status != protocol.ProbeDown {
			t.Fatalf("status = %q, want down", got.Status)
		}
		// There is no latency for a connection that never happened; 0 would read
		// as "answered instantly".
		if got.LatencyMs != nil {
			t.Fatalf("latency = %d, want nil for a failed probe", *got.LatencyMs)
		}
		if elapsed := time.Since(started); elapsed > 3*time.Second {
			t.Fatalf("probe took %s — a hung port must not delay the heartbeat", elapsed)
		}
	})

	t.Run("[TC-PDAGENT-014] treats any http answer below 500 as up", func(t *testing.T) {
		// A dev server with no `/` route answers 404 and is unquestionably up.
		got := ProbeHTTP(t.Context(), httpPort(t, http.StatusNotFound), "/", 2_000)
		if got.Status != protocol.ProbeUp || got.LatencyMs == nil {
			t.Fatalf("probe = %+v, want up with a latency", got)
		}
	})

	t.Run("[TC-PDAGENT-014] treats a 5xx as down — that is the process itself failing", func(t *testing.T) {
		got := ProbeHTTP(t.Context(), httpPort(t, http.StatusBadGateway), "", 2_000)
		if got.Status != protocol.ProbeDown {
			t.Fatalf("status = %q, want down", got.Status)
		}
	})

	t.Run("[TC-PDAGENT-014] reports an http port that answers nothing as down", func(t *testing.T) {
		started := time.Now()
		got := ProbeHTTP(t.Context(), 1, "/health", 500)
		if got.Status != protocol.ProbeDown {
			t.Fatalf("status = %q, want down", got.Status)
		}
		if elapsed := time.Since(started); elapsed > 3*time.Second {
			t.Fatalf("probe took %s", elapsed)
		}
	})

	t.Run("[TC-PDAGENT-014] leaves a `none` probe unknown rather than guessing", func(t *testing.T) {
		service := protocol.NewAgentServiceConfig()
		service.ID = probeServiceID
		service.Port = listeningPort(t)
		service.Probe = protocol.ProbeNone
		got := Service(t.Context(), service, 2_000)
		// `unknown` says "not probed", which is a different statement from `down`.
		if got.ID != probeServiceID || got.Status != protocol.ProbeUnknown || got.LatencyMs != nil {
			t.Fatalf("probe = %+v, want unknown with no latency", got)
		}
	})

	t.Run("[TC-PDAGENT-014] probes every service in one timeout, not one each", func(t *testing.T) {
		services := make([]protocol.AgentServiceConfig, 0, 4)
		for range 4 {
			service := protocol.NewAgentServiceConfig()
			service.ID = probeServiceID
			// Port 1 blackholes nothing on a dev box but is refused; the point of
			// the assertion is the shape of the wait, not the verdict.
			service.Port = 1
			services = append(services, service)
		}
		started := time.Now()
		got := Services(t.Context(), services, 500)
		if len(got) != 4 {
			t.Fatalf("probed %d services, want 4", len(got))
		}
		if elapsed := time.Since(started); elapsed > 2*time.Second {
			t.Fatalf("four probes took %s — they are meant to run in parallel", elapsed)
		}
	})

	t.Run("[TC-PDAGENT-014] returns an empty (never nil) list for a host with no services", func(t *testing.T) {
		got := Services(t.Context(), nil, 500)
		if got == nil {
			t.Fatal("services = nil — it marshals to null and the server rejects the frame")
		}
		if len(got) != 0 {
			t.Fatalf("services = %v", got)
		}
	})
}
