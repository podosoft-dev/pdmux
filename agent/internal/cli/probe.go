package cli

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/coder/websocket"

	agentnet "github.com/podosoft-dev/pdmux/agent/internal/net"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// DefaultProbeTimeout bounds one connect attempt, as the TypeScript's 8_000 did.
const DefaultProbeTimeout = 8 * time.Second

// ProbeResult is what `doctor` prints on its connectivity line and what `verify`
// exits on.
type ProbeResult struct {
	OK bool
	// Detail is written for a human: the close code, or who we were welcomed as.
	Detail string
}

// Probe dials the server, waits for the `welcome`, and hangs up.
//
// WHY IT WAITS FOR A FRAME AND NOT JUST THE HANDSHAKE: a reverse proxy will
// happily complete a WebSocket upgrade and then close the socket when the API
// behind it rejects the key. "Connected" without a `welcome` is exactly the
// failure an operator needs to see spelled out — and it is the failure `verify`
// exists to catch before a remote update commits to a candidate binary.
//
// WHY IT DOES NOT SEND `hello`: hello is how an agent announces its version, and
// the server RECORDS it (agent-ingest applies it to the host row and publishes
// host.hello). A verify run is not a running agent — under remote update it is a
// candidate build being interviewed before the swap — so announcing itself would
// stamp the dashboard with a version that may never actually be installed. The
// server sends `welcome` on connection, unprompted, which is all this needs.
//
// WHY IT DOES NOT USE net.Client: that client is the daemon's supervisor. It
// retries forever by design and reports a failure by logging it, so a caller
// cannot get "why" back — and "why" (`closed before welcome (code 4401 …)`) is
// the entire value of this check. It reuses that package's tuning instead, so
// the two dial the same way.
func Probe(ctx context.Context, url, token string, timeout time.Duration) ProbeResult {
	if timeout <= 0 {
		timeout = DefaultProbeTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	header := http.Header{}
	// The key rides in a header, never in the query string: a URL is written to
	// every proxy access log between here and the server.
	header.Set(protocol.AgentKeyHeader, token)

	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		return ProbeResult{Detail: dialDetail(ctx, err, timeout)}
	}
	conn.SetReadLimit(agentnet.ReadLimit)
	// CloseNow, not a close handshake: this is a probe, and waiting for a reply
	// from a server that may be the problem is not something a doctor run should
	// hang on.
	defer conn.CloseNow()

	for {
		_, raw, err := conn.Read(ctx)
		if err != nil {
			return ProbeResult{Detail: readDetail(ctx, err, timeout)}
		}
		frame, err := protocol.DecodeDownstream(raw)
		if err != nil {
			return ProbeResult{Detail: fmt.Sprintf("server sent a frame this build cannot read: %v", err)}
		}
		switch typed := frame.(type) {
		case *protocol.WelcomeFrame:
			return ProbeResult{OK: true, Detail: fmt.Sprintf("welcomed as host %s", typed.HostID)}
		case *protocol.PingFrame:
			// The server's liveness sweep can fire between our upgrade and its
			// welcome. Answering is not this probe's job, but treating a ping as
			// "unexpected first frame" would fail a perfectly healthy host.
			continue
		default:
			return ProbeResult{Detail: fmt.Sprintf("unexpected first frame: %T", frame)}
		}
	}
}

// dialDetail explains a handshake that never completed.
func dialDetail(ctx context.Context, err error, timeout time.Duration) string {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Sprintf("no connection within %dms", timeout.Milliseconds())
	}
	return fmt.Sprintf("connect failed: %v", err)
}

// readDetail explains a socket that opened and then went away.
func readDetail(ctx context.Context, err error, timeout time.Duration) string {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Sprintf("no welcome within %dms", timeout.Milliseconds())
	}
	var closed websocket.CloseError
	if errors.As(err, &closed) {
		// The code is the whole message here: 4401 is "that key is not valid", 403
		// is "this host is disabled", and an operator who sees the number can find
		// it in the docs without reading the server's logs.
		if closed.Reason == "" {
			return fmt.Sprintf("closed before welcome (code %d)", int(closed.Code))
		}
		return fmt.Sprintf("closed before welcome (code %d %s)", int(closed.Code), closed.Reason)
	}
	return fmt.Sprintf("closed before welcome (%v)", err)
}
