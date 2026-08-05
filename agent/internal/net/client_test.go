package net

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/podosoft-dev/pdmux/agent/internal/log"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// The specs drive a REAL WebSocket server rather than a fake transport: the
// things worth pinning here — that the key rides on the upgrade, that a bad
// frame is dropped instead of killing the session, that a drop is followed by a
// second dial — are all properties of the wire, and a hand-written transport
// would be free to agree with the client about all three.

const (
	testToken = "super-secret-token"
	// waitFor bounds every blocking step, so a broken client fails the test in
	// seconds instead of hanging the package until the go test timeout.
	waitFor = 5 * time.Second
)

type serverConn struct {
	t      *testing.T
	conn   *websocket.Conn
	apiKey string
	path   string
}

// next reads one upstream frame, failing the test rather than blocking forever.
func (s *serverConn) next() protocol.UpstreamFrame {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitFor)
	defer cancel()
	_, data, err := s.conn.Read(ctx)
	if err != nil {
		s.t.Fatalf("reading an upstream frame: %v", err)
	}
	frame, err := protocol.DecodeUpstream(data)
	if err != nil {
		s.t.Fatalf("agent sent a frame the contract rejects: %v (%s)", err, data)
	}
	return frame
}

func (s *serverConn) send(frame protocol.DownstreamFrame) {
	s.t.Helper()
	raw, err := protocol.EncodeDownstream(frame)
	if err != nil {
		s.t.Fatalf("encoding %T: %v", frame, err)
	}
	s.sendRaw(string(raw))
}

// sendRaw writes bytes the contract may well refuse — that is the point.
func (s *serverConn) sendRaw(text string) {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitFor)
	defer cancel()
	if err := s.conn.Write(ctx, websocket.MessageText, []byte(text)); err != nil {
		s.t.Fatalf("writing a downstream frame: %v", err)
	}
}

// drop ends the session the way a server restart does: no close handshake.
func (s *serverConn) drop() { _ = s.conn.CloseNow() }

// close ends the session the way the SERVER refuses one: with a code from the
// contract that says which of the four refusals this is.
func (s *serverConn) close(code int, reason string) {
	_ = s.conn.Close(websocket.StatusCode(code), reason)
}

type testServer struct {
	t     *testing.T
	http  *httptest.Server
	conns chan *serverConn
}

func newTestServer(t *testing.T) *testServer {
	t.Helper()
	server := &testServer{t: t, conns: make(chan *serverConn, 8)}
	server.http = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		// The upgrade hijacks the connection, so returning here leaves it open and
		// owned by the test; Cleanup closes whatever is left.
		server.conns <- &serverConn{
			t:      t,
			conn:   conn,
			apiKey: r.Header.Get(protocol.AgentKeyHeader),
			path:   r.URL.Path,
		}
	}))
	t.Cleanup(func() {
		close(server.conns)
		for conn := range server.conns {
			_ = conn.conn.CloseNow()
		}
		server.http.Close()
	})
	return server
}

// accept waits for the next agent connection.
func (s *testServer) accept() *serverConn {
	s.t.Helper()
	select {
	case conn := <-s.conns:
		return conn
	case <-time.After(waitFor):
		s.t.Fatal("the agent never dialled")
		return nil
	}
}

func (s *testServer) wsURL() string {
	return "ws" + strings.TrimPrefix(s.http.URL, "http") + protocol.AgentWSPath
}

// lines is a log sink a spec can read back.
type lines struct {
	mu      sync.Mutex
	written []string
}

func (l *lines) add(line string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.written = append(l.written, line)
}

func (l *lines) joined() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.written, "\n")
}

type harness struct {
	server *testServer
	client *Client
	frames chan protocol.DownstreamFrame
	lines  *lines
}

// received waits for the next frame the client handed to its handler.
func (h *harness) received() protocol.DownstreamFrame {
	h.server.t.Helper()
	select {
	case frame := <-h.frames:
		return frame
	case <-time.After(waitFor):
		h.server.t.Fatal("no frame reached the handler")
		return nil
	}
}

// start builds a client against a live server and runs it until the test ends.
// mutate adjusts the options a given spec cares about.
func start(t *testing.T, mutate func(*Options)) *harness {
	t.Helper()
	server := newTestServer(t)
	sink := &lines{}
	frames := make(chan protocol.DownstreamFrame, 16)

	hello := protocol.NewAgentHello()
	hello.ProtocolVersion = protocol.ProtocolVersion
	hello.AgentVersion = "0.1.0-spec"
	hello.Hostname = "spec-host"
	hello.OS = "linux"
	hello.Arch = "amd64"
	hello.Capabilities = []protocol.AgentCapability{protocol.CapabilityMetrics}

	options := Options{
		URL:   server.wsURL(),
		Token: testToken,
		Hello: hello,
		Logger: log.New(log.Options{
			Level:   log.LevelDebug,
			Sink:    sink.add,
			Secrets: []string{testToken},
		}),
		OnDownstream: func(frame protocol.DownstreamFrame) { frames <- frame },
		// Short and deterministic: a spec asserts the retry HAPPENED and what the
		// counter says, never how long the production schedule waits.
		Backoff: Backoff{Base: 5 * time.Millisecond, Max: 20 * time.Millisecond, Factor: 2, Jitter: 0.2},
		Rand:    func() float64 { return 0.5 },
	}
	if mutate != nil {
		mutate(&options)
	}

	client := New(options)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		client.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(waitFor):
			t.Error("Run did not return after its context was cancelled")
		}
	})
	return &harness{server: server, client: client, frames: frames, lines: sink}
}

// retryLines are the fields of every "Disconnected, retrying" line the client
// wrote.
//
// Parsed into a map rather than matched with Contains, because `delayMs=2` is a
// prefix of `delayMs=20` — an assertion that cannot tell a two-millisecond wait
// from a twenty-millisecond one is exactly the kind that passes against the
// broken code as well as the fixed one.
func retryLines(written string) []map[string]string {
	var out []map[string]string
	for _, line := range strings.Split(written, "\n") {
		if !strings.Contains(line, "Disconnected, retrying") {
			continue
		}
		fields := map[string]string{}
		for _, token := range strings.Fields(line) {
			if key, value, ok := strings.Cut(token, "="); ok {
				fields[key] = value
			}
		}
		out = append(out, fields)
	}
	return out
}

// nextRefusal waits for the client to report why it was refused.
func nextRefusal(t *testing.T, reasons <-chan Reason) Reason {
	t.Helper()
	select {
	case reason := <-reasons:
		return reason
	case <-time.After(waitFor):
		t.Fatal("the client never reported a refusal")
		return ReasonNone
	}
}

func TestClient(t *testing.T) {
	t.Run("[TC-PDAGENT-006] sends hello with the api key header on connect", func(t *testing.T) {
		h := start(t, nil)
		conn := h.server.accept()

		if conn.apiKey != testToken {
			t.Fatalf("%s header = %q, want the token", protocol.AgentKeyHeader, conn.apiKey)
		}
		if conn.path != protocol.AgentWSPath {
			t.Fatalf("dialled %q, want %q", conn.path, protocol.AgentWSPath)
		}
		hello, ok := conn.next().(*protocol.HelloFrame)
		if !ok {
			t.Fatal("the first frame must be hello")
		}
		if hello.Hello.Hostname != "spec-host" {
			t.Fatalf("hello.hostname = %q, want spec-host", hello.Hello.Hostname)
		}
	})

	t.Run("[TC-PDAGENT-006] never puts the key in the query string", func(t *testing.T) {
		// A URL is written to every proxy access log on the way; a header is not.
		h := start(t, nil)
		conn := h.server.accept()
		if strings.Contains(conn.path, testToken) {
			t.Fatalf("the token reached the request path: %q", conn.path)
		}
	})

	t.Run("[TC-PDAGENT-007] drops a malformed downstream frame and stays connected", func(t *testing.T) {
		h := start(t, nil)
		conn := h.server.accept()
		conn.next() // hello

		conn.sendRaw("not json at all")
		conn.sendRaw(`{"type":"welcome"}`) // missing fields
		conn.sendRaw(`{"type":"nope"}`)    // no such branch

		// The socket surviving is the assertion: a live session still answers the
		// next legal frame, and nothing malformed reached the handler.
		conn.send(&protocol.PingFrame{Ts: 1_785_000_000})
		if _, ok := h.received().(*protocol.PingFrame); !ok {
			t.Fatal("the handler saw something other than the one legal frame")
		}
		select {
		case extra := <-h.frames:
			t.Fatalf("a malformed frame reached the handler: %T", extra)
		default:
		}
		if !h.client.Connected() {
			t.Fatal("a malformed frame closed a healthy connection")
		}
	})

	t.Run("[TC-PDAGENT-007] accepts a well-formed frame", func(t *testing.T) {
		h := start(t, nil)
		conn := h.server.accept()
		conn.next() // hello

		conn.send(&protocol.CollectFrame{What: protocol.CollectHeartbeat})
		collect, ok := h.received().(*protocol.CollectFrame)
		if !ok {
			t.Fatal("the collect frame did not reach the handler")
		}
		if collect.What != protocol.CollectHeartbeat {
			t.Fatalf("collect.what = %q, want heartbeat", collect.What)
		}
	})

	t.Run("[TC-PDAGENT-008] refuses to send an upstream frame the contract rejects", func(t *testing.T) {
		h := start(t, nil)
		conn := h.server.accept()
		conn.next() // hello

		beat := protocol.NewHeartbeat()
		beat.Ts = -5 // epochSeconds is non-negative
		if h.client.Send(&protocol.HeartbeatFrame{Heartbeat: beat}) {
			t.Fatal("Send accepted a frame the contract rejects")
		}
		// The next frame the server reads proves the rejected one never went out.
		if !h.client.Send(&protocol.PongFrame{Ts: 1_785_000_000}) {
			t.Fatal("a legal frame was refused")
		}
		if _, ok := conn.next().(*protocol.PongFrame); !ok {
			t.Fatal("the invalid heartbeat reached the wire")
		}
	})

	// The exact counts are load-bearing, not decoration: the attempt counter is the
	// exponent backoff.Delay raises, so ONE extra increment per drop halves every
	// wait in the schedule. The TypeScript hit this — `ws` emits close after error,
	// so scheduling from the error handler too counted each dropped connection
	// twice. Go makes it structurally impossible (session() returns exactly one
	// reason per connection), and this is what keeps it that way.
	t.Run("[TC-PDAGENT-009] reconnects on close and resets the counter once healthy", func(t *testing.T) {
		h := start(t, nil)
		first := h.server.accept()
		first.next() // hello
		first.drop()

		second := h.server.accept()
		second.next() // hello
		if got := h.client.Attempts(); got != 1 {
			t.Fatalf("attempts after one drop = %d, want 1 (two = the double-count bug)", got)
		}

		// What a welcome does: this session is proven, so the next drop starts the
		// schedule over rather than continuing to double.
		h.client.MarkHealthy()
		if got := h.client.Attempts(); got != 0 {
			t.Fatalf("attempts after markHealthy = %d, want 0", got)
		}
		second.drop()

		third := h.server.accept()
		third.next() // hello
		if got := h.client.Attempts(); got != 1 {
			t.Fatalf("attempts after a healthy session dropped = %d, want 1 (the counter did not reset)", got)
		}
	})

	t.Run("[TC-PDAGENT-030] never writes the token into a log line", func(t *testing.T) {
		h := start(t, nil)
		conn := h.server.accept()
		conn.next() // hello
		conn.sendRaw("not json at all")
		conn.drop()
		// The reconnect line is the one that carries the URL, so wait for it.
		h.server.accept().next()

		if written := h.lines.joined(); strings.Contains(written, testToken) {
			t.Fatalf("the token reached the log:\n%s", written)
		}
		if !strings.Contains(h.lines.joined(), "Connecting to server") {
			t.Fatal("the connect line is missing — the assertion above proved nothing")
		}
	})

	// Untagged: the pong moved into the client during the Go port. In the
	// TypeScript the runtime answered it (apps/agent/src/agent.ts), but the read
	// loop is the only part of a Go agent guaranteed to be running and unblocked,
	// and the server terminates a host that answers neither ping within 30s.
	t.Run("answers the server ping with a pong, and still delivers it", func(t *testing.T) {
		h := start(t, func(options *Options) {
			options.Now = func() time.Time { return time.Unix(1_785_000_123, 0) }
		})
		conn := h.server.accept()
		conn.next() // hello

		conn.send(&protocol.PingFrame{Ts: 1_785_000_000})
		pong, ok := conn.next().(*protocol.PongFrame)
		if !ok {
			t.Fatal("the agent did not answer the ping")
		}
		if pong.Ts != 1_785_000_123 {
			t.Fatalf("pong.ts = %d, want the clock's seconds", pong.Ts)
		}
		// Still delivered: the runtime may want to know the server is probing.
		if _, ok := h.received().(*protocol.PingFrame); !ok {
			t.Fatal("the ping was swallowed instead of dispatched")
		}
	})

	// Untagged: Go-specific. An unrecovered panic in a handler takes the whole
	// daemon down, where the TypeScript only lost one frame to a throw.
	t.Run("a panicking handler does not take the reader loop with it", func(t *testing.T) {
		var once sync.Once
		delivered := make(chan protocol.DownstreamFrame, 4)
		h := start(t, func(options *Options) {
			options.OnDownstream = func(frame protocol.DownstreamFrame) {
				panicked := false
				once.Do(func() { panicked = true })
				if panicked {
					panic("handler exploded")
				}
				delivered <- frame
			}
		})
		conn := h.server.accept()
		conn.next() // hello

		conn.send(&protocol.CollectFrame{What: protocol.CollectRepos}) // panics
		conn.send(&protocol.CollectFrame{What: protocol.CollectHeartbeat})

		select {
		case frame := <-delivered:
			if collect, ok := frame.(*protocol.CollectFrame); !ok || collect.What != protocol.CollectHeartbeat {
				t.Fatalf("the frame after the panic was %T", frame)
			}
		case <-time.After(waitFor):
			t.Fatal("the reader loop died with the handler")
		}
		if !h.client.Connected() {
			t.Fatal("a panicking handler closed the connection")
		}
	})

	// ⚠ THE REASON USED TO BE LEARNED AND THEN THROWN AWAY, twice over: an upgrade
	// refused with 401 put its status in `_` and became the text "connect failed:
	// …", and a close code was formatted into a log line by closeReason() and
	// never compared to anything. So a revoked token and a server outage were the
	// same event everywhere it mattered, and both retried forever.
	t.Run("[TC-PDAGENT-115] tells a refusal from a drop and says which", func(t *testing.T) {
		refusals := make(chan Reason, 8)
		h := start(t, func(options *Options) {
			options.OnRefused = func(reason Reason) { refusals <- reason }
		})

		// A close code the contract defines: the number reaches something that acts
		// on it rather than only a log line.
		conn := h.server.accept()
		conn.next() // hello
		conn.close(protocol.AgentCloseTokenRevoked, "token revoked")
		if got := nextRefusal(t, refusals); got != ReasonTokenRevoked {
			t.Fatalf("close %d reported %q, want %q", protocol.AgentCloseTokenRevoked, got, ReasonTokenRevoked)
		}

		conn = h.server.accept()
		conn.next()
		conn.close(protocol.AgentCloseHostDeleted, "host deleted")
		if got := nextRefusal(t, refusals); got != ReasonHostDeleted {
			t.Fatalf("close %d reported %q", protocol.AgentCloseHostDeleted, got)
		}

		// An ordinary drop is nobody's decision, so it must NOT be reported as a
		// refusal — a breadcrumb that recorded every server restart as one would
		// make the field meaningless.
		conn = h.server.accept()
		conn.next()
		conn.drop()
		h.server.accept().next()
		select {
		case unexpected := <-refusals:
			t.Fatalf("a plain drop was reported as a refusal: %q", unexpected)
		default:
		}
	})

	t.Run("[TC-PDAGENT-115] reads the status of a refused UPGRADE, which is never a close code", func(t *testing.T) {
		// An auth refusal happens before there is a WebSocket to close, so this is
		// the only place the fact exists at all.
		for status, want := range map[int]Reason{
			http.StatusUnauthorized: ReasonRefused,
			http.StatusForbidden:    ReasonRefused,
			// A gateway being wrong is transient by nature and must keep the ordinary
			// schedule — a 502 is not a decision about this host.
			http.StatusBadGateway: ReasonNone,
		} {
			var refused int
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				refused++
				w.WriteHeader(status)
			}))
			defer server.Close()

			reasons := make(chan Reason, 4)
			client := New(Options{
				URL:       "ws" + strings.TrimPrefix(server.URL, "http") + protocol.AgentWSPath,
				Token:     testToken,
				Logger:    log.Silent(),
				Backoff:   Backoff{Base: 5 * time.Millisecond, Max: 20 * time.Millisecond, Factor: 2},
				Rand:      func() float64 { return 0.5 },
				OnRefused: func(reason Reason) { reasons <- reason },
			})
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			go func() { defer close(done); client.Run(ctx) }()

			if want == ReasonNone {
				// Nothing to wait for, so wait for the retry that proves a dial happened
				// and no refusal came with it.
				time.Sleep(100 * time.Millisecond)
				select {
				case got := <-reasons:
					t.Fatalf("status %d reported %q, want no refusal", status, got)
				default:
				}
				if refused == 0 {
					t.Fatalf("status %d: the client never dialled, so the assertion proved nothing", status)
				}
			} else if got := nextRefusal(t, reasons); got != want {
				t.Fatalf("status %d reported %q, want %q", status, got, want)
			}
			cancel()
			<-done
		}
	})

	// ⚠ THE AGENT MUST NEVER GIVE UP — `Restart=always` has to mean always, and a
	// host that stopped dialling needs somebody with SSH. What a terminal refusal
	// changes is the CEILING, so a deleted host stops asking twice a minute
	// forever for something only a person can grant.
	t.Run("[TC-PDAGENT-116] backs off further on a refusal a retry cannot fix", func(t *testing.T) {
		schedule := Backoff{Base: time.Second, Max: 30 * time.Second, Factor: 2, Jitter: 0}
		terminal := schedule
		terminal.Max = DefaultTerminalMax

		// Deep enough that both schedules are pinned at their ceiling: that is where
		// the difference is, and where an abandoned agent actually lives.
		ordinary := Delay(20, schedule, func() float64 { return 0.5 })
		longer := Delay(20, terminal, func() float64 { return 0.5 })
		if ordinary != schedule.Max {
			t.Fatalf("the ordinary schedule stopped at %s, want %s", ordinary, schedule.Max)
		}
		if longer != DefaultTerminalMax {
			t.Fatalf("the terminal schedule stopped at %s, want %s", longer, DefaultTerminalMax)
		}
		if longer <= ordinary {
			t.Fatal("a terminal refusal must wait longer than an outage does, or the cap does nothing")
		}
		// The early retries are deliberately unchanged: a token really can be
		// replaced in the first minute.
		if first, firstTerminal := Delay(1, schedule, nil), Delay(1, terminal, nil); first != firstTerminal {
			t.Fatalf("the first retry differs (%s vs %s); only the ceiling may change", first, firstTerminal)
		}

		for reason, want := range map[Reason]bool{
			ReasonRefused:      true,
			ReasonHostDisabled: true,
			ReasonTokenRevoked: true,
			ReasonHostDeleted:  true,
			// A race, not a refusal: the winner may be a stale socket the server is
			// about to sweep, and the loser has to be dialling when it does.
			ReasonReplaced: false,
			ReasonNone:     false,
		} {
			if got := reason.Terminal(); got != want {
				t.Fatalf("%q.Terminal() = %v, want %v", reason, got, want)
			}
		}
	})

	t.Run("[TC-PDAGENT-116] waits longer after a terminal refusal, and still keeps dialling", func(t *testing.T) {
		// ⚠ THE WIRING, NOT THE ARITHMETIC. The schedule is chosen inside Run, and
		// the two assertions above pass just as happily when nothing consults them —
		// this reads the delay Run ACTUALLY picked off its own retry line. Jitter is
		// off and the ordinary ceiling is deliberately below the base, so both
		// numbers are exact rather than approximately different.
		h := start(t, func(options *Options) {
			options.Backoff = Backoff{Base: time.Second, Max: 2 * time.Millisecond, Factor: 2, Jitter: 0}
			options.TerminalMax = 40 * time.Millisecond
		})

		conn := h.server.accept()
		conn.next() // hello
		conn.drop()

		conn = h.server.accept()
		conn.next()
		conn.close(protocol.AgentCloseHostDisabled, "host disabled")
		// The dial after a terminal refusal is the "never gives up" half: the cap is
		// a ceiling on the wait, not a decision to stop, because a host that is
		// re-enabled has to come back without somebody SSHing into it.
		h.server.accept().next()

		retries := retryLines(h.lines.joined())
		if len(retries) < 2 {
			t.Fatalf("expected a retry line per drop, got %d:\n%s", len(retries), h.lines.joined())
		}
		if got := retries[0]["delayMs"]; got != "2" {
			t.Fatalf("an ordinary drop waited %sms, want the ordinary ceiling (2)", got)
		}
		if got := retries[0]["refusal"]; got != "" {
			t.Fatalf("an ordinary drop was logged as refusal %q", got)
		}
		if got := retries[1]["delayMs"]; got != "40" {
			t.Fatalf("a terminal refusal waited %sms, want the terminal ceiling (40)", got)
		}
		if got := retries[1]["refusal"]; got != string(ReasonHostDisabled) {
			t.Fatalf("refusal = %q, want %q", got, ReasonHostDisabled)
		}
	})

	t.Run("reports a send on a socket that is not up as a failure", func(t *testing.T) {
		// The producers (heartbeat timer, terminal pumps) run whether or not the
		// socket is up, and a silent true would make a dropped frame look delivered.
		client := New(Options{URL: "ws://127.0.0.1:1/agent/ws", Logger: log.Silent()})
		if client.Send(&protocol.PongFrame{Ts: 1_785_000_000}) {
			t.Fatal("Send reported success with no connection")
		}
		if client.Connected() {
			t.Fatal("Connected is true before anything dialled")
		}
	})
}

// TestSlowWriteIsReported guards the instrumentation, not the socket.
//
// ⚠ THE THRESHOLD MOVES, NOT THE WIRE. A spec cannot make a real socket block on
// demand — that is the whole difficulty of the bug this line was added for — so
// the bar is dropped to a nanosecond and every write becomes a slow one. What is
// asserted is that the agent SAYS SO, which is the part that kept being missing:
// three rounds of "every terminal on that host went slow at once, but ssh to it
// is fine" ended without an answer because conn.Write was never timed, and a
// timer that nobody proves can fire is the same as no timer at all.
func TestSlowWriteIsReported(t *testing.T) {
	h := start(t, func(options *Options) {
		options.SlowWriteThreshold = time.Nanosecond
	})
	// `hello` is written by the client the moment the socket comes up, so accepting
	// the connection is enough to have timed a real write.
	h.server.accept()

	deadline := time.After(waitFor)
	for {
		if strings.Contains(h.lines.joined(), "Slow frame write") {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("every write was over the threshold and none was reported:\n%s", h.lines.joined())
		case <-time.After(10 * time.Millisecond):
		}
	}
}
