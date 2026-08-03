package cli

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

const (
	probeToken = "probe-token-value"
	// The stub server hands out a fixed id, so a spec can assert the report
	// names the host the server actually welcomed.
	testHostID = "11111111-2222-4333-8444-555555555555"
)

// probeServer runs a real WebSocket endpoint. A hand-written transport would be
// free to agree with the client about the two things worth pinning here — that
// the key rides on the upgrade, and that an upgrade WITHOUT a welcome is a
// failure rather than a success.
func probeServer(t *testing.T, handle func(conn *websocket.Conn, key string)) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		handle(conn, r.Header.Get(protocol.AgentKeyHeader))
	}))
	t.Cleanup(server.Close)
	return "ws" + strings.TrimPrefix(server.URL, "http") + protocol.AgentWSPath
}

func sendDownstream(t *testing.T, conn *websocket.Conn, frame protocol.DownstreamFrame) {
	t.Helper()
	raw, err := protocol.EncodeDownstream(frame)
	if err != nil {
		t.Fatalf("encoding %T: %v", frame, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("writing %T: %v", frame, err)
	}
}

func TestProbe(t *testing.T) {
	t.Run("[TC-PDAGENT-033] reports success when a welcome arrives", func(t *testing.T) {
		var presented string
		url := probeServer(t, func(conn *websocket.Conn, key string) {
			presented = key
			sendDownstream(t, conn, &protocol.WelcomeFrame{HostID: testHostID, Config: protocol.NewAgentConfig()})
			time.Sleep(50 * time.Millisecond)
			conn.CloseNow()
		})
		result := Probe(context.Background(), url, probeToken, 5*time.Second)
		if !result.OK {
			t.Fatalf("probe failed: %s", result.Detail)
		}
		if !strings.Contains(result.Detail, testHostID) {
			t.Fatalf("detail = %q, want the host it was welcomed as", result.Detail)
		}
		if presented != probeToken {
			t.Fatalf("the key must ride on the upgrade header, got %q", presented)
		}
	})

	t.Run("[TC-PDAGENT-033] reports a socket that closes before the welcome", func(t *testing.T) {
		// The failure a reverse proxy produces: the upgrade completes, and the API
		// behind it then rejects the key.
		url := probeServer(t, func(conn *websocket.Conn, _ string) {
			conn.Close(4401, "unauthorised")
		})
		result := Probe(context.Background(), url, probeToken, 5*time.Second)
		if result.OK {
			t.Fatal("an upgrade without a welcome is not a working connection")
		}
		if !strings.Contains(result.Detail, "4401") {
			t.Fatalf("detail = %q, want the close code an operator can look up", result.Detail)
		}
	})

	t.Run("reports a server that is not there at all", func(t *testing.T) {
		result := Probe(context.Background(), "ws://127.0.0.1:1"+protocol.AgentWSPath, probeToken, 2*time.Second)
		if result.OK {
			t.Fatal("nothing is listening on port 1")
		}
		if result.Detail == "" {
			t.Fatal("a failed dial must say why")
		}
	})

	t.Run("waits out a ping that races the welcome", func(t *testing.T) {
		// The server's liveness sweep can fire between the upgrade and the welcome.
		// Treating that as "unexpected first frame" would fail a healthy host.
		url := probeServer(t, func(conn *websocket.Conn, _ string) {
			sendDownstream(t, conn, &protocol.PingFrame{Ts: 1})
			sendDownstream(t, conn, &protocol.WelcomeFrame{HostID: testHostID, Config: protocol.NewAgentConfig()})
			time.Sleep(50 * time.Millisecond)
			conn.CloseNow()
		})
		if result := Probe(context.Background(), url, probeToken, 5*time.Second); !result.OK {
			t.Fatalf("probe failed: %s", result.Detail)
		}
	})

	t.Run("gives up when a connected server says nothing", func(t *testing.T) {
		url := probeServer(t, func(conn *websocket.Conn, _ string) {
			time.Sleep(2 * time.Second)
			conn.CloseNow()
		})
		result := Probe(context.Background(), url, probeToken, 300*time.Millisecond)
		if result.OK {
			t.Fatal("silence is not a welcome")
		}
		if !strings.Contains(result.Detail, "no welcome within 300ms") {
			t.Fatalf("detail = %q", result.Detail)
		}
	})

	t.Run("never announces itself as an agent", func(t *testing.T) {
		// `hello` is what the server RECORDS as this host's running version. A
		// verify run is a candidate build being interviewed, so sending it would
		// stamp the dashboard with a version that may never be installed.
		frames := make(chan []byte, 4)
		url := probeServer(t, func(conn *websocket.Conn, _ string) {
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				defer cancel()
				if _, data, err := conn.Read(ctx); err == nil {
					frames <- data
				}
				close(frames)
			}()
			sendDownstream(t, conn, &protocol.WelcomeFrame{HostID: testHostID, Config: protocol.NewAgentConfig()})
			time.Sleep(200 * time.Millisecond)
			conn.CloseNow()
		})
		if result := Probe(context.Background(), url, probeToken, 5*time.Second); !result.OK {
			t.Fatalf("probe failed: %s", result.Detail)
		}
		select {
		case frame, ok := <-frames:
			if ok {
				t.Fatalf("the probe sent %s", frame)
			}
		case <-time.After(time.Second):
		}
	})
}
