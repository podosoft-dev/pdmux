// Package agent is the daemon: one connection, two timers, and whatever the
// server asks for.
//
// The agent ships with defaults but is STEERED BY THE SERVER — intervals, git
// roots, service probes and usage providers all arrive in `welcome`/`config`.
// That is what makes a host reconfigurable from the dashboard: changing what a
// machine reports must never mean logging into it again.
//
// Ported from apps/agent/src/agent.ts. The rules are the same; three things are
// shaped differently because Go is not an event loop:
//
//   - EVERY PASS RUNS ON ITS OWN GOROUTINE. Node dispatched frames on the same
//     loop that read the socket, so it could `await` a collector inside a frame
//     handler for free. Here the goroutine that dispatches IS the read loop, and
//     the read loop is the keepalive — it is what answers the server's ping
//     within the 30-second sweep. A git pass run inline would cost the socket.
//   - THE STATE THE PASSES SHARE IS LOCKED. `config`, the discovered repo list
//     and the host id are written by the dispatching goroutine and read by two
//     collectors running elsewhere.
//   - A PASS THAT PANICS IS CAUGHT. The TypeScript's try/catch lost one pass; an
//     unrecovered panic in a goroutine takes the whole daemon down with it.
package agent

import (
	"context"
	"os"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/collect"
	"github.com/podosoft-dev/pdmux/agent/internal/git"
	"github.com/podosoft-dev/pdmux/agent/internal/log"
	"github.com/podosoft-dev/pdmux/agent/internal/net"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/sample"
	"github.com/podosoft-dev/pdmux/agent/internal/state"
	"github.com/podosoft-dev/pdmux/agent/internal/term"
	"github.com/podosoft-dev/pdmux/agent/internal/usage"
)

// DefaultVersion is what an unversioned build reports.
//
// It is a PRERELEASE OF the floor (protocol.MinSupportedAgent is `0.1.0-0`)
// rather than something like `0.0.0-dev`: a prerelease sorts below its release,
// so a bare `0.0.0` build would be under the floor and every developer's own
// machine would wear a red `incompatible` badge. A release passes the real
// version in through Options.
const DefaultVersion = "0.1.0-dev"

// Repos are batched by size so one `repos` frame cannot become a megabyte.
const (
	repoFrameMaxBytes = 512 * 1024
	repoFrameMaxCount = 8
)

// slowPass is when a collector's wall time is worth a line.
//
// Two seconds is above every healthy pass — the heartbeat's collectors are
// bounded by their own timeouts (a 4s `tmux list-sessions`, a 2s service probe)
// and the git pass is a few hundred milliseconds on a normal checkout — while
// still being far below the intervals themselves (5s, 60s, 120s), so a pass that
// trips this is one that ate a meaningful share of its own period.
const slowPass = 2 * time.Second

// transportStatsInterval is how often the socket's behaviour is summarised.
//
// Thirty seconds is short enough that a person who says "it is slow right now"
// has at least one line covering the moment, and long enough that an idle fleet
// costs two lines a minute in journald. It is deliberately NOT tunable from the
// server: this is the measurement used to decide whether the server is the
// problem, and a knob the suspect controls is not a measurement.
const transportStatsInterval = 30 * time.Second

// Which level a summary line is written at.
//
// ⚠ MEASURED: AT INFO ON EVERY TICK, THIS LINE WAS 75% OF THE AGENT'S JOURNAL —
// ~120 of ~160 lines an hour, on every connected host, forever. The "say nothing
// when idle" guard never engaged because the heartbeat itself writes a frame
// every five seconds, so no connected host is ever idle by that test. journald
// caps total size either way; the cost was retention — thousands of lines of
// "still healthy" pushing out the history that gets read during an incident.
//
// So the summary is written at DEBUG while it says what the baseline already
// says, and at INFO when it says something else — the bar sits well above the
// measured healthy figures (p95 0–3 ms, max 0–5 ms) and well below the one-shot
// warning thresholds, so the interesting minute is on the record before the
// warnings would fire. One INFO an hour goes out regardless: a journal where
// the line is absent must mean "nothing noteworthy", never "who knows".
const (
	statsNoteworthyP95Ms  = 10
	statsNoteworthyMaxMs  = 50
	statsInfoAtLeastEvery = time.Hour
)

// statsWorthInfo is the level decision, kept pure so the spec can state it
// without running the timer loop.
func statsWorthInfo(writes, locks sample.Summary, sinceLastInfo time.Duration) bool {
	if sinceLastInfo >= statsInfoAtLeastEvery {
		return true
	}
	return writes.P95.Milliseconds() >= statsNoteworthyP95Ms ||
		writes.Max.Milliseconds() >= statsNoteworthyMaxMs ||
		locks.P95.Milliseconds() >= statsNoteworthyP95Ms ||
		locks.Max.Milliseconds() >= statsNoteworthyMaxMs
}

// Field caps the contract states on `hello`. Truncating here rather than sending
// an over-long value is deliberate: a host with a 300-character hostname must
// still appear on the dashboard.
const (
	maxHostname = 255
	maxVersion  = 32
)

// Options configure an Agent. Everything below the URL and token has a working
// default; the seams exist so a spec can describe a whole host without owning
// one.
type Options struct {
	// URL is the wss:// endpoint, already normalised by internal/config.
	URL string
	// Token authenticates the upgrade. Register it as a logger secret before
	// building the agent.
	Token string
	// Logger records connection and pass events; nil silences the package.
	Logger *log.Logger
	// Hostname overrides what this host calls itself — a container reports its
	// container id otherwise. Empty asks the OS.
	Hostname string
	// Version is reported in `hello` and in every `updateStatus`. Empty is
	// DefaultVersion; a release build passes the linker's value.
	Version string

	// UpdateAbility answers "could this host start itself again after replacing
	// its binary". nil is NoUpdateAbility, which says no.
	UpdateAbility func() protocol.AgentUpdateAbility
	// Update handles the `update` frame. nil declines every update with
	// `NOT_SUPPORTED` — see update.go.
	Update UpdateHandler

	// HeartbeatDeps replaces the host collectors, so a pass needs no real host.
	// The diagnostics view is always the agent's own regardless.
	HeartbeatDeps *collect.Deps
	// LedgerStore is where the acked-detail ledger is kept; nil resolves the
	// state directory from the environment.
	LedgerStore git.Store
	// LinkStore records whether this agent was ever accepted, and why not since,
	// for `pdmux-agent instances` to read offline. nil resolves the same state
	// directory the ledger uses.
	LinkStore *state.LinkStore
	// SpawnPTY replaces the real pty, so the terminal path needs no shell.
	SpawnPTY func(spec term.Spec) (term.Process, error)
}

// Agent owns the one connection and everything that reports over it.
type Agent struct {
	client    *net.Client
	terminals *term.Manager
	ledger    *git.DetailLedger
	store     git.Store
	links     *state.LinkStore
	// serverURL is what this agent dials, recorded in the breadcrumb so a stray
	// agent can be traced back to the dashboard it belongs to without opening its
	// 0600 config file.
	serverURL   string
	usage       *usage.CachedCollector
	diagnostics *collect.DiagnosticsCollector
	deps        collect.Deps
	logger      *log.Logger
	version     string
	update      UpdateHandler

	// The timer loops read these; applyConfig writes them. Buffered so a `config`
	// frame never waits on a collector — see retune.
	heartbeatReset chan time.Duration
	gitReset       chan time.Duration

	// A pass in flight refuses a second one. `collect` is an on-demand request
	// from the server and lands on top of whatever the timer is already doing.
	heartbeatRunning atomic.Bool
	gitRunning       atomic.Bool
	// execSlots bounds concurrent commands; see exec.go for why this is a
	// semaphore rather than the single flag the other passes use.
	execSlots chan struct{}

	// passes tracks work started off the dispatch goroutine, so shutdown drains
	// it instead of racing it.
	passes sync.WaitGroup

	// ctx is the run context. It is written once at the top of Run and read only
	// by the dispatch goroutine — which is the goroutine Run blocks on, since
	// net.Client.Run reads the socket in line rather than in a goroutine of its
	// own. No lock is needed, and none would help if that ever changed.
	ctx context.Context

	mu             sync.Mutex
	config         protocol.AgentConfig
	repos          []git.DiscoveredRepo
	hostID         string
	heartbeatArmed bool
	gitArmed       bool
}

// New builds an Agent. It does not connect; Run does.
func New(options Options) *Agent {
	logger := options.Logger
	if logger == nil {
		logger = log.Silent()
	}
	version := options.Version
	if version == "" {
		version = DefaultVersion
	}
	// The contract's defaults, in force until the server's `welcome` replaces
	// them. Nothing reports on them: the timers stay stopped until then.
	config := protocol.NewAgentConfig()

	updater := options.Update
	if updater == nil {
		updater = UnsupportedUpdater{}
	}
	ability := options.UpdateAbility
	if ability == nil {
		ability = NoUpdateAbility
	}
	store := options.LedgerStore
	links := options.LinkStore
	if store == nil || links == nil {
		// Resolved once for both: it probes the filesystem to work out which unit
		// this process is running under, and asking twice would answer twice.
		dir := state.ResolveDir(state.DirInput{Env: environ()})
		if store == nil {
			store = git.NewFileStore(dir)
		}
		if links == nil {
			links = state.NewLinkStore(dir)
		}
	}

	a := &Agent{
		store:          store,
		links:          links,
		serverURL:      options.URL,
		logger:         logger,
		version:        version,
		update:         updater,
		heartbeatReset: make(chan time.Duration, 1),
		gitReset:       make(chan time.Duration, 1),
		execSlots:      make(chan struct{}, execSlots),
		config:         config,
		repos:          []git.DiscoveredRepo{},
		ctx:            context.Background(),
	}
	a.usage = usage.NewCachedCollector(usage.CachedCollectorOptions{
		TTLSec: config.UsageIntervalSec,
		Log:    logger,
	})
	a.diagnostics = collect.NewDiagnosticsCollector(collect.DiagnosticsOptions{})
	a.ledger = git.NewDetailLedger(git.DefaultPerRepoCap, store)

	deps := collect.NewDeps(a.usage)
	if options.HeartbeatDeps != nil {
		deps = *options.HeartbeatDeps
	}
	// The diagnostics view is always the agent's own, even when a spec injects
	// the collectors — otherwise the one thing that reports degradation would be
	// the thing a test silently drops.
	deps.Diagnostics = a.diagnostics
	if deps.Log == nil {
		deps.Log = logger
	}
	a.deps = deps

	a.terminals = term.NewManager(term.Options{
		Logger: logger,
		Send: func(frame protocol.TerminalServerFrame) {
			a.client.Send(&protocol.TerminalUpstream{Frame: frame})
		},
		MaxPendingBytes: config.TerminalBufferBytes,
		Spawn:           options.SpawnPTY,
	})
	a.client = net.New(net.Options{
		URL:          options.URL,
		Token:        options.Token,
		Hello:        BuildHello(options.Hostname, version, options.URL, ability()),
		Logger:       logger,
		OnDownstream: a.onDownstream,
		OnDisconnect: func() {
			// ⚠ COUNTED BEFORE THE CLOSE, AND LOGGED EVEN WHEN IT IS ZERO. This is
			// the line that tells a socket DROP apart from a socket STALL, and the
			// two are indistinguishable from the browser: both look like every pane
			// on the host going quiet at once. If this line is absent while panes
			// froze, the socket stayed up and the stall is downstream (see the slow
			// write and lock-wait lines); if it is present, the panes died with the
			// connection and reattached, which is a different bug with a different
			// fix. Guessing which one it was is what cost the previous rounds.
			shell, session := a.terminals.Counts()
			a.logger.Warn("Socket dropped, closing terminals",
				log.F("shellPanes", shell),
				log.F("sessionPanes", session))
			// The ptys belong to this socket; a `session` terminal loses only its
			// viewer because the multiplexer session outlives it.
			a.terminals.CloseAll()
		},
		OnRefused: a.recordRefusal,
	})
	return a
}

// Run connects and stays connected until ctx is cancelled, then shuts down
// cleanly. It blocks; the daemon runs it as its main loop.
//
// The returned error is nil on a clean shutdown. Nothing else is fatal: a failed
// collector contributes its own empty value and a dropped socket is retried, so
// the one way out of this loop is the context.
func (a *Agent) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	a.ctx = ctx

	// Two loops, not one. A git pass costs seconds on a large checkout and a
	// heartbeat is due every five, so a shared timer would make the cheap
	// collector wait behind the expensive one — and the heartbeat is the frame
	// that decides whether the dashboard thinks this host is alive.
	var timers sync.WaitGroup
	timers.Add(3)
	go func() { defer timers.Done(); a.tick(ctx, "heartbeat", a.heartbeatReset, a.heartbeatPass) }()
	go func() { defer timers.Done(); a.tick(ctx, "git", a.gitReset, a.gitPass) }()
	// A third loop rather than a job on one of the two above: this one must report
	// what the OTHER work did to the socket, so it cannot share a timer with the
	// thing it is measuring — a summary emitted from inside the git pass would
	// always be read at the same phase of that pass and would never see the rest.
	go func() { defer timers.Done(); a.transportStats(ctx) }()

	// Blocks until ctx ends, reconnecting on its own in between. Downstream
	// frames are dispatched on THIS goroutine.
	a.client.Run(ctx)

	// Shutdown order matters. Timers first, so nothing new starts; then drain the
	// passes, which may be holding a git runner or writing the ledger and whose
	// Send now simply fails; the socket is already closed by the client on its
	// way out, which took the ptys with it through OnDisconnect. CloseAll here is
	// for the case that misses — a Run that never connected still owns whatever
	// was opened.
	cancel()
	timers.Wait()
	a.passes.Wait()
	a.terminals.CloseAll()
	return nil
}

// HostID is the identity this server assigned, or "" before `welcome`. Read by
// `doctor` and by specs.
func (a *Agent) HostID() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.hostID
}

// Config is the configuration currently in force.
func (a *Agent) Config() protocol.AgentConfig {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.config
}

// TerminalBufferBytes is the live per-pane output cap.
func (a *Agent) TerminalBufferBytes() int { return a.terminals.BufferBytes() }

// TerminalPanes is how many panes are open of each kind.
//
// It exists for the updater, which reports the pair with `accepted`: a restart
// ends the shell panes and everything running in them, while the session panes
// re-attach. The daemon hands this method to the update engine after building
// the agent — the engine is an argument to New, so the wiring cannot go the
// other way.
func (a *Agent) TerminalPanes() (shell, session int) { return a.terminals.Counts() }

// UsageIntervalSec is the live usage refresh interval.
func (a *Agent) UsageIntervalSec() int { return a.usage.TTL() }

// Version is what this build reports in `hello`.
func (a *Agent) Version() string { return a.version }

// BuildHello is the first frame on every connection.
//
// hostname empty asks the OS; version empty is DefaultVersion. serverURL is only
// read to work out which of this host's addresses reaches it — see address.go,
// and note that nothing is sent to it here. The capability list is this build's,
// and it is ⚠ a closed enum in the contract — inventing a member an older server
// does not know fails the whole `hello`, and that host silently vanishes from
// the dashboard. Anything that needs to grow on its own goes in `update`
// instead, which is an object.
func BuildHello(hostname, version, serverURL string, ability protocol.AgentUpdateAbility) protocol.AgentHello {
	if hostname == "" {
		hostname, _ = os.Hostname()
	}
	if version == "" {
		version = DefaultVersion
	}
	hello := protocol.NewAgentHello()
	hello.ProtocolVersion = protocol.ProtocolVersion
	hello.AgentVersion = clip(version, maxVersion)
	hello.Hostname = clip(hostname, maxHostname)
	// Empty when the kernel will not say and no interface qualifies — a real
	// answer, and the contract defaults it, so nothing here can fail the frame.
	hello.Address = clip(PrimaryAddress(serverURL), maxHostname)
	hello.OS = runtime.GOOS
	hello.Arch = runtime.GOARCH
	hello.Capabilities = []protocol.AgentCapability{
		protocol.CapabilityMetrics,
		protocol.CapabilitySessions,
		protocol.CapabilityTerminal,
		protocol.CapabilityGit,
		protocol.CapabilityUsage,
		protocol.CapabilityServices,
		protocol.CapabilityExec,
	}
	hello.Update = ability
	return hello
}

// onDownstream applies one server frame. It runs on the goroutine Run blocks on,
// which is also the read loop — so nothing here may block for long.
func (a *Agent) onDownstream(frame protocol.DownstreamFrame) {
	switch f := frame.(type) {
	case *protocol.WelcomeFrame:
		a.welcome(f)
	case *protocol.ConfigFrame:
		a.logger.Info("Adopted updated configuration")
		a.applyConfig(f.Config)
	case *protocol.PingFrame:
		// Answered inside the read loop (internal/net) rather than here: the pong
		// must go out even while this handler is busy, because the server drops a
		// host that answered neither ping within 30 seconds.
	case *protocol.CollectFrame:
		// An explicit refresh, so a click does not wait out the interval. The pass
		// itself refuses to double-run.
		switch f.What {
		case protocol.CollectHeartbeat:
			a.spawnPass("heartbeat", a.heartbeatPass)
		case protocol.CollectRemote:
			// ⚠ ITS OWN PASS, NOT PART OF THE GIT ONE. Every other collector reads
			// local files; this one waits on a network per repository, so folding it
			// into the periodic pass would make that pass as slow as the slowest
			// unreachable remote on the host — every interval, forever.
			a.spawnPass("remote", a.remotePass)
		default:
			a.spawnPass("git", a.gitPass)
		}
	case *protocol.TerminalDownstream:
		// Straight through to the manager, which owns every pane and serialises
		// what goes back up this socket.
		a.terminals.Handle(f.Frame)
	case *protocol.CommitDetailFrame:
		repoPath, shas := f.RepoPath, slices.Clone(f.Shas)
		a.spawnPass("detail", func(ctx context.Context) { a.detailPass(ctx, repoPath, shas) })
	case *protocol.FileTreeFrame:
		repoPath, sha := f.RepoPath, f.SHA
		a.spawnPass("tree", func(ctx context.Context) { a.treePass(ctx, repoPath, sha) })
	case *protocol.FileContentFrame:
		repoPath, sha, path := f.RepoPath, f.SHA, f.Path
		a.spawnPass("blob", func(ctx context.Context) { a.blobPass(ctx, repoPath, sha, path) })
	case *protocol.DetailAckFrame:
		// The server HAS these, so they are never rebuilt again — across restarts.
		a.ledger.Ack(f.RepoPath, f.Shas)
		a.logger.Debug("Recorded stored details",
			log.F("repoPath", f.RepoPath),
			log.F("count", len(f.Shas)))
	case *protocol.UpdateFrame:
		a.handleUpdate(f.Update)
	case *protocol.ExecFrame:
		// Off this goroutine: the read loop must not wait out a command's timeout.
		command := f.Exec
		a.spawnPass("exec", func(ctx context.Context) { a.handleExec(ctx, command) })
	}
}

func (a *Agent) welcome(frame *protocol.WelcomeFrame) {
	a.mu.Lock()
	a.hostID = frame.HostID
	a.mu.Unlock()
	// Reaching an open socket is not being accepted; a welcome is. Only now does
	// the retry counter reset.
	a.client.MarkHealthy()
	// And only now is a self-update committed — for the same reason, one line
	// later. An updater that replaced this binary has been waiting for exactly
	// this event to clear its probation marker and report the outcome; a process
	// that started and could not connect is what the marker exists to catch.
	// Inline, like the ledger below: it is two small file reads, and deferring it
	// would delay a report this connection has already earned.
	a.commitUpdate()
	// And only now is the breadcrumb written, for the third time on the same
	// argument: `welcome` is acceptance, an open socket is not. Inline like the
	// two above — one small 0600 write, and the moment worth recording is exactly
	// this one.
	a.recordConnected(frame)
	// Before the first git pass: whatever this server already stored is work this
	// agent must not redo.
	a.ledger.Adopt(frame.HostID)
	a.logger.Info("Adopted server configuration",
		log.F("hostId", frame.HostID),
		log.F("serverVersion", frame.ServerVersion))
	a.applyConfig(frame.Config)
	// Both at once, and neither on this goroutine: the first heartbeat is what
	// puts values on the card, and it must not wait behind a git scan of every
	// configured root.
	a.spawnPass("heartbeat", a.heartbeatPass)
	a.spawnPass("git", a.gitPass)
}

// recordConnected leaves the breadcrumb `pdmux-agent instances` reads.
//
// ⚠ THE EXPIRY IS OPTIONAL AND STAYS OPTIONAL. A server too old to send it says
// nothing, and a token minted without one has none — both arrive as nil, and
// neither is a date. Recording 0 for either would put an expiry in the past into
// the file and make a healthy agent read as one whose credential lapsed.
func (a *Agent) recordConnected(frame *protocol.WelcomeFrame) {
	connect := state.Connect{
		Server: a.serverURL,
		HostID: frame.HostID,
		At:     time.Now(),
	}
	if frame.TokenExpiresAt != nil {
		// Unparseable means the server said something this build does not
		// understand. Leaving the field out is the honest answer; claiming an
		// expiry we could not read would be worse than admitting we have none.
		if at, err := time.Parse(time.RFC3339, *frame.TokenExpiresAt); err == nil {
			connect.TokenExpiresAt = at.Unix()
		}
	}
	err := a.links.Connected(connect)
	if err != nil {
		// Costs the offline answer and nothing else — the agent is connected, which
		// is the state the file was about to describe. A read-only state directory
		// must not turn a working session into a failure.
		a.logger.Warn("Cannot record this connection", log.F("error", err))
	}
}

// recordRefusal is the other half, and the half that matters: it runs when the
// server would NOT take this agent, which is the case nothing anywhere could
// answer before. It is called from the client's retry loop, off this goroutine.
func (a *Agent) recordRefusal(reason net.Reason) {
	if err := a.links.Refused(a.serverURL, string(reason), time.Now()); err != nil {
		a.logger.Warn("Cannot record this refusal", log.F("error", err), log.F("refusal", string(reason)))
	}
}

// applyConfig adopts what the server sent — LIVE, without a reconnect. A server
// that raises a terminal buffer or a probe timeout is reacting to a host that is
// misbehaving right now, and "restart the agent to apply it" is not an answer at
// that moment.
func (a *Agent) applyConfig(config protocol.AgentConfig) {
	a.mu.Lock()
	previous := a.config
	a.config = config
	// A timer that has never been armed must be armed even when the interval
	// happens to equal the default — until `welcome` the loops are stopped.
	retuneHeartbeat := !a.heartbeatArmed || previous.HeartbeatSec != config.HeartbeatSec
	retuneGit := !a.gitArmed || previous.GitIntervalSec != config.GitIntervalSec
	a.heartbeatArmed, a.gitArmed = true, true
	a.mu.Unlock()

	a.usage.SetProviders(usage.NewProviders(config.UsageProviders, usage.RegistryOptions{}))
	a.usage.SetTTL(config.UsageIntervalSec)
	a.terminals.SetBufferBytes(config.TerminalBufferBytes)
	// Observations about the previous roots/providers describe a configuration
	// that no longer exists; keeping them would report a root nobody asked for.
	if !slices.Equal(previous.GitRoots, config.GitRoots) ||
		!slices.Equal(previous.UsageProviders, config.UsageProviders) {
		a.diagnostics.Reset()
	}
	if retuneHeartbeat {
		retune(a.heartbeatReset, time.Duration(config.HeartbeatSec)*time.Second)
	}
	if retuneGit {
		retune(a.gitReset, time.Duration(config.GitIntervalSec)*time.Second)
	}
}

// tick runs one collector on an interval the server may change at any moment.
func (a *Agent) tick(ctx context.Context, name string, reset <-chan time.Duration, pass func(context.Context)) {
	// Stopped until the server's first config arrives. The TypeScript created the
	// interval inside applyConfig for the same reason: a host that reported before
	// it heard from the server would be reporting the agent's defaults rather than
	// the fleet's, on a schedule nobody chose.
	ticker := time.NewTicker(time.Hour)
	ticker.Stop()
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case interval := <-reset:
			ticker.Reset(interval)
		case <-ticker.C:
			a.spawnPass(name, pass)
		}
	}
}

// transportStats summarises the socket and the send lock on a fixed timer.
//
// ⚠ IT EXISTS BECAUSE THE THRESHOLDS ALONE WERE NOT ENOUGH. The warnings above
// fire when one write or one lock wait crosses a bar that was guessed before
// anyone had a distribution to guess from — and on the first reproduction after
// they shipped, a person watched a terminal lag while every counter read zero.
// Zero means "nothing crossed 250ms", not "nothing was wrong", and there was no
// way to tell those apart. This line makes them distinguishable: it prints what
// normal looks like on this host, so the next report can be compared against a
// number rather than an assumption.
func (a *Agent) transportStats(ctx context.Context) {
	ticker := time.NewTicker(transportStatsInterval)
	defer ticker.Stop()
	lastInfo := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			writes, bytes := a.client.DrainWriteStats()
			locks := a.terminals.DrainLockWaitStats()
			// An idle host says nothing. A summary of zero frames is noise that
			// would make the interesting lines harder to find in journald, which is
			// where somebody will be reading these under time pressure.
			if writes.Count == 0 {
				continue
			}
			shell, session := a.terminals.Counts()
			// ⚠ THE PROCESS'S OWN SIZE IS PART OF THE MEASUREMENT, because the thing
			// that actually made terminals fast again was RESTARTING THIS PROCESS —
			// no code fixed anything. systemd's accounting caught it after the fact:
			// agents replaced at ~22 hours had peaked at 141-191 MB against ~50 MB
			// for a fresh one, and the host that felt slowest was the one that had
			// grown most and begun to swap. That is the "worse the longer it is
			// open" report, measured. Growth here IS the hypothesis, so it has to be
			// on the same line as the latency it is supposed to explain.
			//
			// `goroutines` is the load-bearing field: heap can grow for honest
			// reasons, but a goroutine count that climbs with `opensTotal` while
			// `panes` stays flat is a pane that was closed and never let go — which
			// is the leak this is looking for, stated as a number.
			var mem runtime.MemStats
			runtime.ReadMemStats(&mem)
			// ⚠ THE HOST'S OWN LOAD BELONGS ON THIS LINE, because every other number
			// here is measured DOWNSTREAM of where the delay is felt. A keystroke goes
			// pty write -> multiplexer -> the program -> redraw -> pty read, and only
			// then reaches anything timed above. Measured on a host reported slow with
			// "cpu is fine at 11%": its coding-agent processes had 99-155 MB each
			// swapped out, so every redraw faulted pages back in and stalled while the
			// cpu sat idle — invisible in cpu%, but load1 counts uninterruptible sleep
			// and rises for exactly that. Without it, "all my numbers are zero and the
			// user says it is slow" has no next step.
			fields := []log.Field{
				log.F("writes", writes.Count),
				log.F("writeP50Ms", writes.P50.Milliseconds()),
				log.F("writeP95Ms", writes.P95.Milliseconds()),
				log.F("writeMaxMs", writes.Max.Milliseconds()),
				log.F("lockWaits", locks.Count),
				log.F("lockP95Ms", locks.P95.Milliseconds()),
				log.F("lockMaxMs", locks.Max.Milliseconds()),
				log.F("bytes", bytes),
				log.F("panes", shell+session),
				log.F("opensTotal", a.terminals.OpenedTotal()),
				log.F("goroutines", runtime.NumGoroutine()),
				log.F("heapMB", mem.HeapAlloc>>20),
				log.F("sysMB", mem.Sys>>20),
			}
			// Omitted rather than reported as zero when the host will not say: a load
			// of 0.00 and "there is no /proc/loadavg here" are opposite readings, and
			// a field that cannot tell them apart is worse than an absent one.
			if load1, ok := collect.ReadLoad1(); ok {
				fields = append(fields, log.F("load1", load1))
			}
			if statsWorthInfo(writes, locks, time.Since(lastInfo)) {
				lastInfo = time.Now()
				a.logger.Info("Transport stats", fields...)
			} else {
				a.logger.Debug("Transport stats", fields...)
			}
		}
	}
}

// spawnPass runs one pass off the caller's goroutine, so neither a retune nor
// the read loop waits on a collector. Overlap is refused by the pass itself.
func (a *Agent) spawnPass(name string, pass func(context.Context)) {
	ctx := a.ctx
	a.passes.Add(1)
	go func() {
		defer a.passes.Done()
		defer a.recoverPass(name)
		started := time.Now()
		pass(ctx)
		// ⚠ A PASS IS OFF THE HOT PATH BUT NOT OFF THE WIRE. Every pass ends by
		// sending, and those sends share one socket with every terminal on this
		// host, so a pass that runs long is a candidate for the freeze the panes
		// felt. The git pass batches up to 512 KiB across 8 repos per frame and the
		// usage pass runs INSIDE the heartbeat with a 20s RPC timeout — both are
		// large enough to matter and neither was timed anywhere.
		if elapsed := time.Since(started); elapsed >= slowPass {
			a.logger.Warn("Slow pass",
				log.F("pass", name),
				log.F("ms", elapsed.Milliseconds()))
		}
	}()
}

// recoverPass is the Go shape of the TypeScript's per-pass try/catch. There it
// cost one pass; here an unrecovered panic in a goroutine takes the daemon down
// on the host it was installed to watch.
func (a *Agent) recoverPass(name string) {
	panicked := recover()
	if panicked == nil {
		return
	}
	a.logger.Error("Pass failed", log.F("pass", name), log.F("panic", panicked))
}

// retune hands a timer loop a new interval without ever blocking the caller: a
// `config` frame arrives on the read loop, and that goroutine must not wait on a
// collector to notice it. The channel holds one value — the newest wins, since a
// superseded interval is not worth applying.
func retune(reset chan time.Duration, interval time.Duration) {
	if interval <= 0 {
		return
	}
	select {
	case <-reset:
	default:
	}
	select {
	case reset <- interval:
	default:
	}
}

// environ is the process environment as a map, for state.ResolveDir — which
// reads PDMUX_STATE_DIR, XDG_STATE_HOME and HOME to decide where a systemd unit,
// a user unit and a bare shell each keep their ledger.
func environ() map[string]string {
	values := os.Environ()
	out := make(map[string]string, len(values))
	for _, entry := range values {
		if key, value, found := strings.Cut(entry, "="); found {
			out[key] = value
		}
	}
	return out
}

// clip truncates to the contract's cap. Bytes rather than runes: every field it
// guards is a hostname or a version, and a value long enough to need clipping is
// already not what the operator meant.
func clip(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[:limit]
}
