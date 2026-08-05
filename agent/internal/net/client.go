// Package net is the agent's one connection: an OUTBOUND WebSocket to the server.
//
// WHY OUTBOUND ONLY: the whole point of this design is that a host joins the
// dashboard without an inbound port, a VPN, a public name or a distributed SSH
// key. Everything the server wants to do — reconfigure, collect, open a terminal
// — travels back down this socket as a frame.
//
// THE KEY TRAVELS IN A HEADER, never in the query string: a URL is written to
// every proxy access log between here and the server, and a token in one of
// those is a credential someone else's log rotation is now responsible for.
//
// Every incoming frame is validated against the shared contract before it
// reaches any handler. A malformed frame is logged and DROPPED: one bad message
// from a half-upgraded server must not take down a connection that is otherwise
// fine, and must certainly not crash the daemon.
//
// Ported from apps/agent/src/net/{client,backoff}.ts. The rules are the same;
// the shape is not. The TypeScript injected a socket factory and a timer API to
// stay testable — here the loop is a goroutine bounded by a context, and the
// specs drive a real WebSocket server rather than a transport that can only ever
// agree with the client.
package net

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/podosoft-dev/pdmux/agent/internal/log"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/sample"
)

const (
	// DefaultDialTimeout bounds the handshake — the TypeScript's handshakeTimeout.
	// Without it a black-holed server (a dropped SYN, not a refused one) parks the
	// agent in a dial that never returns and never retries.
	DefaultDialTimeout = 10 * time.Second

	// DefaultWriteTimeout bounds one frame. A consumer that stopped reading turns
	// every Send into a permanent block otherwise, and Send is called from the
	// heartbeat timer and from every terminal pump.
	DefaultWriteTimeout = 10 * time.Second

	// ReadLimit is the largest downstream frame accepted. The library's default is
	// 32 KiB, and the server sends one frame that is not bounded by anything the
	// agent controls: the `detailAck` after every connect lists every sha it has
	// already stored for this host, so it grows with the host's history. Exceeding
	// the limit does not drop a frame — it CLOSES THE CONNECTION — which would turn
	// a busy host into a reconnect loop, so the ceiling is set well above any
	// legitimate frame instead.
	ReadLimit = 4 << 20

	// maxCloseReason bounds what a remote close reason can write into our log.
	maxCloseReason = 200

	// SlowWriteThreshold is when one frame's socket write is worth a line.
	//
	// ⚠ THIS IS THE MEASUREMENT THAT TELLS "THE AGENT IS SLOW" APART FROM "THE
	// SERVER STOPPED READING", AND UNTIL IT EXISTED THERE WAS NO WAY TO ASK.
	// conn.Write blocks when the peer is not draining, and everything this agent
	// says queues behind it: term.Manager serialises every pane onto one lock, and
	// this socket also carries the heartbeat, the git pass, file reads and exec
	// results. So ONE slow write freezes EVERY terminal on this host at once —
	// while ssh to the same machine stays crisp, because ssh shares none of it.
	// That is the exact shape this was reported in, more than once, with the host's
	// cpu, memory and disk all healthy and nothing anywhere to point at.
	//
	// The number is set against measurement rather than taste: on the deployment it
	// was reported from, this agent reaches the server over the VPC at 0.05ms RTT
	// and a frame writes in about 1ms. 250ms is 250x that — well outside anything
	// healthy, and well short of DefaultWriteTimeout, which would otherwise be the
	// first and only sign that anything had gone wrong.
	SlowWriteThreshold = 250 * time.Millisecond
)

// Options configure a Client. Everything with a sensible default may be left
// zero; the specs set the injectable ones to make timing and jitter assertable.
type Options struct {
	// URL is the wss:// endpoint, already normalised by internal/config.
	URL string
	// Token authenticates the upgrade. Register it as a logger secret before
	// building the client — this package logs the URL it dials.
	Token string
	Hello protocol.AgentHello
	// Logger records every connection event; nil silences the package, which is
	// what a spec wants and a daemon never does — a socket that fails quietly is
	// the hardest thing here to debug from a host you are not sitting at.
	Logger *log.Logger
	// OnDownstream receives every frame that passed the contract. It runs on the
	// reader goroutine, so it must not block for long.
	OnDownstream func(frame protocol.DownstreamFrame)
	// OnConnect fires after hello is sent; OnDisconnect fires when a session that
	// was open ends (the terminals belong to the socket and are torn down there).
	OnConnect    func()
	OnDisconnect func()
	// OnRefused fires when a session ended for a reason the SERVER chose — a
	// refused upgrade, or a close code that names a cause. It does NOT fire for an
	// ordinary drop, which nobody decided. It runs on the retry goroutine between
	// two sessions, so it must not block for long.
	//
	// It exists so the runtime can leave the breadcrumb an operator reads later:
	// an agent that is refused is otherwise invisible from both ends.
	OnRefused func(reason Reason)
	// Backoff is the retry schedule; the zero value is DefaultBackoff.
	Backoff Backoff
	// TerminalMax is the ceiling for a refusal that retrying cannot fix; zero is
	// DefaultTerminalMax. See Reason.Terminal.
	TerminalMax time.Duration
	// Rand is the jitter source; nil uses the process source.
	Rand func() float64
	// HTTPClient dials the handshake; nil uses http.DefaultClient.
	HTTPClient   *http.Client
	DialTimeout  time.Duration
	WriteTimeout time.Duration
	// SlowWriteThreshold is when a frame's write earns a line; zero uses
	// SlowWriteThreshold. Injectable for the same reason the timeouts are: a spec
	// cannot make a real socket block on demand, so the only way to assert that
	// the report fires is to move the bar rather than the wire.
	SlowWriteThreshold time.Duration
	// Now is the clock behind the pong timestamp; nil uses time.Now.
	Now func() time.Time
}

// Client keeps the agent connected, reconnecting on its own with a jittered
// exponential backoff.
type Client struct {
	url          string
	token        string
	hello        protocol.AgentHello
	logger       *log.Logger
	onDownstream func(frame protocol.DownstreamFrame)
	onConnect    func()
	onDisconnect func()
	onRefused    func(reason Reason)
	backoff      Backoff
	terminalMax  time.Duration
	random       func() float64
	httpClient   *http.Client
	dialTimeout  time.Duration
	writeTimeout time.Duration
	slowWrite    time.Duration
	now          func() time.Time

	// mu guards the live socket and the counters. Send is called from the
	// heartbeat timer, the git pass and every terminal pump while the reader
	// goroutine is replacing the connection underneath them.
	mu      sync.Mutex
	conn    *websocket.Conn
	open    bool
	attempt int

	// writes times every conn.Write; bytes counts what went with them. Read and
	// reset together by DrainWriteStats, which the agent logs on a timer.
	writes     *sample.Set
	writeBytes atomic.Int64
}

// New builds a Client. It does not dial; Run does.
func New(options Options) *Client {
	logger := options.Logger
	if logger == nil {
		logger = log.Silent()
	}
	client := &Client{
		url:          options.URL,
		token:        options.Token,
		hello:        options.Hello,
		logger:       logger,
		onDownstream: options.OnDownstream,
		onConnect:    options.OnConnect,
		onDisconnect: options.OnDisconnect,
		onRefused:    options.OnRefused,
		backoff:      options.Backoff.withDefaults(),
		terminalMax:  options.TerminalMax,
		random:       options.Rand,
		httpClient:   options.HTTPClient,
		dialTimeout:  options.DialTimeout,
		writeTimeout: options.WriteTimeout,
		slowWrite:    options.SlowWriteThreshold,
		now:          options.Now,
		writes:       sample.New(0),
	}
	if client.slowWrite <= 0 {
		client.slowWrite = SlowWriteThreshold
	}
	if client.dialTimeout <= 0 {
		client.dialTimeout = DefaultDialTimeout
	}
	if client.writeTimeout <= 0 {
		client.writeTimeout = DefaultWriteTimeout
	}
	if client.terminalMax <= 0 {
		client.terminalMax = DefaultTerminalMax
	}
	if client.now == nil {
		client.now = time.Now
	}
	return client
}

// DrainWriteStats returns how the socket has been behaving since the last call
// and starts a fresh interval. Bytes is what went out with those writes.
//
// It is the agent, not this package, that decides when to read: the interval and
// the log line belong with the other periodic work, and a client that logged on
// its own timer would report a window nobody could line up against the passes
// and the terminals it is competing with.
func (c *Client) DrainWriteStats() (sample.Summary, int64) {
	return c.writes.Drain(), c.writeBytes.Swap(0)
}

// Connected reports whether a session is up right now.
func (c *Client) Connected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.open
}

// Attempts is retries since the last healthy session — exposed for logs and specs.
func (c *Client) Attempts() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.attempt
}

// MarkHealthy is called by the runtime when a welcome proves the session works.
//
// Reaching an open socket is not the same as being accepted: a server that
// accepts the upgrade and then closes on a bad token would otherwise reset the
// counter on every attempt and hammer it at the base delay forever.
func (c *Client) MarkHealthy() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.attempt = 0
}

// Run dials, reads until the session ends, waits out the backoff and dials
// again — until ctx is cancelled. It blocks; the daemon runs it as its main loop.
//
// ⚠ THE LOOP STILL HAS EXACTLY ONE EXIT, AND THAT IS ON PURPOSE. A refusal
// changes how long it waits, never whether it keeps trying: the unit says
// `Restart=always` because a host that gives up needs somebody with SSH, which
// is the brick this whole design avoids.
func (c *Client) Run(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		end := c.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if end.Reason != ReasonNone && c.onRefused != nil {
			// Before the wait, not after: on a terminal refusal the wait is minutes,
			// and the breadcrumb is what somebody reads during them.
			c.onRefused(end.Reason)
		}
		c.mu.Lock()
		c.attempt++
		attempt := c.attempt
		c.mu.Unlock()
		// The same curve with a higher ceiling, rather than a second schedule: the
		// early retries of a refusal still want to be quick (a token really can be
		// replaced in the first minute), and only the tail changes.
		schedule := c.backoff
		if end.Reason.Terminal() {
			schedule.Max = c.terminalMax
		}
		delay := Delay(attempt, schedule, c.random)
		fields := []log.Field{
			log.F("reason", end.Detail),
			log.F("attempt", attempt),
			log.F("delayMs", delay.Milliseconds()),
		}
		if end.Reason != ReasonNone {
			// Named separately from the free-text reason because this is the value
			// worth grepping for, and the one that decided the delay above.
			fields = append(fields, log.F("refusal", string(end.Reason)))
		}
		c.logger.Warn("Disconnected, retrying", fields...)
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

// sessionEnd is why one connection ended: the line that goes to the log, and
// the reason the retry schedule and the breadcrumb act on. They are returned
// together because the reason used to exist only inside the line.
type sessionEnd struct {
	Reason Reason
	Detail string
}

// session runs one connection from handshake to failure and returns why it
// ended. Every exit path is a reason to retry, so it never returns an error.
func (c *Client) session(ctx context.Context) sessionEnd {
	c.logger.Info("Connecting to server", log.F("url", c.url))
	header := http.Header{}
	header.Set(protocol.AgentKeyHeader, c.token)

	dialCtx, cancelDial := context.WithTimeout(ctx, c.dialTimeout)
	conn, response, err := websocket.Dial(dialCtx, c.url, &websocket.DialOptions{
		HTTPClient: c.httpClient,
		HTTPHeader: header,
	})
	cancelDial()
	if err != nil {
		// ⚠ THE STATUS IS READ HERE, NOT DISCARDED. An auth refusal never becomes a
		// close code — the server answers the UPGRADE with 401/403 and there is no
		// WebSocket yet to close — so this is the only place the fact exists. It
		// used to go into `_`, which is why a revoked token and a server outage
		// looked identical for as long as either lasted. The response is nil when
		// the failure was below HTTP (a refused connection, a black hole, a timeout),
		// and that is an ordinary drop.
		reason := ReasonNone
		if response != nil {
			reason = reasonForStatus(response.StatusCode)
		}
		return sessionEnd{
			Reason: reason,
			Detail: fmt.Sprintf("connect failed: %v", truncate(err.Error(), maxCloseReason)),
		}
	}
	conn.SetReadLimit(ReadLimit)

	c.setConn(conn)
	// Registered before the first callback runs: whatever hello or onConnect does,
	// this session must not leave a socket behind that Send would keep writing to.
	defer func() {
		c.clearConn()
		if ctx.Err() == nil {
			_ = conn.CloseNow()
			return
		}
		// Shutting down: a clean close tells the server this host went away on
		// purpose, so it drops the registry slot now instead of waiting out its
		// sweep. The handshake waits up to five seconds for the peer's reply
		// though, and a stopping agent must not hang on a server that may be the
		// reason it is stopping — so the reply is nobody's problem here: the frame
		// goes out from a goroutine this one does not join.
		go func() { _ = conn.Close(websocket.StatusNormalClosure, "agent stopping") }()
	}()

	c.logger.Info("Connected to server")
	c.Send(&protocol.HelloFrame{Hello: c.hello})
	if c.onConnect != nil {
		c.onConnect()
	}

	for {
		// ⚠ THE READ LOOP IS ALSO THE KEEPALIVE. coder/websocket answers the
		// server's protocol-level pings, but only from inside a read — a client that
		// stops reading (or only writes) looks dead to the server's 30s sweep even
		// though its socket is fine.
		_, data, err := conn.Read(ctx)
		if err != nil {
			return closeEnd(err)
		}
		c.handleMessage(data)
	}
}

// Send validates a frame and writes it. It reports whether the frame reached
// the socket, and never blocks longer than the write timeout.
//
// Terminal frames are exempt from validation on purpose: they arrive dozens of
// times a second and their shape is produced locally, so the check would be pure
// overhead on the hottest path in the agent. The exemption lives in
// protocol.EncodeUpstream, which is where the same rule is stated for the server.
func (c *Client) Send(frame protocol.UpstreamFrame) bool {
	conn := c.currentConn()
	if conn == nil {
		return false
	}
	raw, err := protocol.EncodeUpstream(frame)
	if err != nil {
		c.logger.Error("Dropping invalid upstream frame",
			log.F("type", frameLabel(frame)),
			log.F("error", err))
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), c.writeTimeout)
	defer cancel()
	started := time.Now()
	err = conn.Write(ctx, websocket.MessageText, raw)
	elapsed := time.Since(started)
	if err != nil {
		c.logger.Warn("Failed to send frame",
			log.F("type", frameLabel(frame)),
			log.F("ms", elapsed.Milliseconds()),
			log.F("error", err))
		return false
	}
	// Timed on every frame because the failure being hunted is intermittent and
	// nobody is watching when it happens: a threshold that only a human can arm is
	// a threshold that is always disarmed. `time.Since` is a monotonic clock read,
	// so the cost of asking is far below the cost of the write it is timing.
	//
	// ⚠ RECORDED WHETHER OR NOT IT CROSSES THE BAR, and that is the whole point of
	// this line. The threshold below was guessed before anybody had a distribution
	// to guess from, and on the first real reproduction it reported nothing while a
	// person watched their terminal lag — which is indistinguishable from "healthy"
	// unless the normal case is also recorded. The summary is what says which.
	c.writes.Add(elapsed)
	c.writeBytes.Add(int64(len(raw)))
	if elapsed >= c.slowWrite {
		c.logger.Warn("Slow frame write — the server may not be reading",
			log.F("type", frameLabel(frame)),
			log.F("ms", elapsed.Milliseconds()),
			log.F("bytes", len(raw)))
	}
	return true
}

func (c *Client) handleMessage(raw []byte) {
	frame, err := protocol.DecodeDownstream(raw)
	if err != nil {
		// Dropped, not fatal: a half-upgraded server that sends one frame this build
		// cannot read must still be able to tell this agent to update itself.
		c.logger.Warn("Discarding invalid downstream frame",
			log.F("bytes", len(raw)),
			log.F("error", err))
		return
	}
	// The pong is answered here rather than by the runtime: the server's sweep
	// terminates an agent that answered neither ping within 30 seconds, and this
	// loop is the one part of the agent guaranteed to be running and unblocked.
	// Answering before dispatch means a slow handler cannot cost us the socket.
	if _, isPing := frame.(*protocol.PingFrame); isPing {
		c.Send(&protocol.PongFrame{Ts: c.now().Unix()})
	}
	c.dispatch(frame)
}

func (c *Client) dispatch(frame protocol.DownstreamFrame) {
	if c.onDownstream == nil {
		return
	}
	// A handler that fails must not close a healthy connection — the TypeScript
	// caught a throwing handler for the same reason. In Go an unrecovered panic
	// takes the whole process, so this recover is the difference between one
	// broken frame and a daemon that exits on the host it was installed to watch.
	defer func() {
		if recovered := recover(); recovered != nil {
			c.logger.Error("Handler failed for frame",
				log.F("type", frameLabel(frame)),
				log.F("panic", fmt.Sprint(recovered)))
		}
	}()
	c.onDownstream(frame)
}

func (c *Client) setConn(conn *websocket.Conn) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.conn, c.open = conn, true
}

func (c *Client) clearConn() {
	c.mu.Lock()
	wasOpen := c.open
	c.conn, c.open = nil, false
	c.mu.Unlock()
	if wasOpen && c.onDisconnect != nil {
		c.onDisconnect()
	}
}

func (c *Client) currentConn() *websocket.Conn {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.open {
		return nil
	}
	return c.conn
}

// frameLabel names a frame for a log line.
//
// It prints the Go type rather than the wire discriminator because the union's
// stamp method is unexported — that is what closes the union — and a switch over
// all fourteen branches here would be a second copy of the branch table whose
// only job is to make one log line prettier.
func frameLabel(frame any) string {
	return fmt.Sprintf("%T", frame)
}

// closeEnd renders why a read ended, bounded — and KEEPS THE CLOSE CODE.
//
// This was `closeReason`, which formatted the number into the string and threw
// it away; nothing ever compared it, so the four codes the contract defines for
// a refusal (4000 replaced, 4002 host disabled, 4003 token revoked, 4004 host
// deleted) reached nothing that could act on them. The text is still what goes
// to journald, bounded because the remote side chose it; the reason is what the
// retry schedule and the breadcrumb read.
func closeEnd(err error) sessionEnd {
	if status := websocket.CloseStatus(err); status != -1 {
		return sessionEnd{
			Reason: reasonForClose(int(status)),
			Detail: truncate(fmt.Sprintf("close %d: %v", int(status), err), maxCloseReason),
		}
	}
	return sessionEnd{Detail: truncate(err.Error(), maxCloseReason)}
}

func truncate(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[:limit]
}
