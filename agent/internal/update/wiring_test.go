package update

// The engine AS THE DAEMON ASSEMBLES IT — a real agent, a real socket, a real
// artifact server, and this package's Engine wired in as the update handler, the
// committer and the source of the pane counts.
//
// WHY THESE SPECS EXIST NEXT TO engine_test.go. That file drives the Engine
// directly, which proves the sequence but says nothing about whether anything
// ever calls it. The joins are what break in practice: an `update` frame that
// reaches an agent whose handler is still the default decliner, a `done` that is
// never sent because nothing tells the engine a handshake happened, a pane
// warning that reads 0/0 because the counter was never wired. Each of those
// passes every spec in engine_test.go.
//
// cmd/pdmux-agent/daemon.go is package main with no seam a spec can reach, so
// the harness below performs the SAME ASSEMBLY IN THE SAME ORDER: build the
// engine, ask it about a probation marker before anything dials, hand it to
// agent.New, then give it the agent's panes. If daemon.go and this file ever
// disagree, this file is the one that is tested.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/podosoft-dev/pdmux/agent/internal/agent"
	"github.com/podosoft-dev/pdmux/agent/internal/collect"
	"github.com/podosoft-dev/pdmux/agent/internal/git"
	"github.com/podosoft-dev/pdmux/agent/internal/log"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/state"
	"github.com/podosoft-dev/pdmux/agent/internal/term"
)

const (
	wiredHostID = "33333333-4444-4555-8666-777777777777"
	// wiredWait bounds every blocking step so a broken join fails in seconds
	// instead of hanging the package.
	wiredWait = 5 * time.Second
	// wiredSettle is how long an assertion of ABSENCE waits before believing
	// itself.
	wiredSettle = 250 * time.Millisecond
)

// ---------------------------------------------------------------------------
// A host with an agent on it
// ---------------------------------------------------------------------------

type wiredSetup struct {
	// stateDir and binDir are shared between two harnesses when a spec needs the
	// SAME HOST to start a second time — which is what a restart after a swap is.
	stateDir string
	binDir   string
	// version is what this build reports, given to the agent and the engine
	// together exactly as the daemon gives it.
	version string
	// installed is the content of the executable before anything happens.
	installed string
	tune      func(*Options)
}

type wiredHarness struct {
	t        *testing.T
	stateDir string
	exe      string
	artifact []byte

	engine  *Engine
	agent   *agent.Agent
	startup StartupOutcome

	server *httptest.Server
	conn   *websocket.Conn

	mu     sync.Mutex
	frames []protocol.UpstreamFrame
	exits  []int
	// verifySaw is what was installed at the moment Gate 1 ran, recorded here for
	// the same reason engine_test.go records it: the candidate must be interviewed
	// while the old binary is still in place.
	verifySaw string
	verifyRan int
}

func startWired(t *testing.T, options ...func(*wiredSetup)) *wiredHarness {
	t.Helper()

	setup := wiredSetup{
		stateDir:  t.TempDir(),
		binDir:    t.TempDir(),
		version:   "0.1.0",
		installed: oldBinary,
	}
	for _, apply := range options {
		apply(&setup)
	}

	h := &wiredHarness{
		t:        t,
		stateDir: setup.stateDir,
		exe:      filepath.Join(setup.binDir, "pdmux-agent"),
		artifact: []byte(newBinary),
	}
	if _, err := os.Stat(h.exe); err != nil {
		writeExecutable(t, h.exe, setup.installed)
	}

	// One origin for both, because the agent has one: the artifact URL is DERIVED
	// from the endpoint this agent authenticated to, never supplied.
	accepted := make(chan *websocket.Conn, 4)
	mux := http.NewServeMux()
	mux.HandleFunc(protocol.AgentWSPath, func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		go h.read(conn)
		accepted <- conn
	})
	mux.HandleFunc("/releases/pdmux-agent", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(h.artifact)
	})
	h.server = httptest.NewServer(mux)
	t.Cleanup(h.server.Close)

	url := wsURL(h.server.URL)
	opts := Options{
		ExePath:   h.exe,
		StateDir:  h.stateDir,
		ServerURL: url,
		Token:     "agent-key",
		Version:   setup.version,
		Settle:    0,
		// Pinned: the artifact claims linux/amd64, and a spec that only passes on
		// the machine it was written on is not testing the architecture check.
		GOOS:   "linux",
		GOARCH: "amd64",
		// Empty rather than inherited, so the probe below reads the same on a
		// developer's shell and inside a CI unit that sets INVOCATION_ID.
		Env:  map[string]string{},
		Exit: func(code int) { h.record(func() { h.exits = append(h.exits, code) }) },
		Ability: func() protocol.AgentUpdateAbility {
			return protocol.AgentUpdateAbility{CanRestart: true, RestartMode: protocol.RestartSystemd}
		},
		Verify: func(_ context.Context, _ string, _ VerifySpec) error {
			h.record(func() {
				h.verifyRan++
				h.verifySaw = readFile(t, h.exe)
			})
			return nil
		},
	}
	if setup.tune != nil {
		setup.tune(&opts)
	}
	h.engine = New(opts)

	// THE ORDER daemon.go USES. Gate 2 is read before a socket exists, because a
	// build that cannot dial has no server to be told about by.
	h.startup = h.engine.Startup()

	h.agent = agent.New(agent.Options{
		URL:           url,
		Token:         "agent-key",
		Logger:        log.Silent(),
		Hostname:      "wired-host",
		Version:       setup.version,
		Update:        h.engine,
		UpdateAbility: abilityFor(opts),
		HeartbeatDeps: &collect.Deps{
			Resource: collect.ResourceReaders{
				Memory:    func() *collect.MemoryReading { return nil },
				Disk:      func(context.Context) *collect.DiskReading { return nil },
				Load:      func() (float64, bool) { return 0, false },
				UptimeSec: func() (int64, bool) { return 0, false },
			},
			Sessions: func(context.Context) collect.SessionReading {
				return collect.SessionReading{Sessions: []protocol.MuxSession{}, Present: true}
			},
			Now: func() int64 { return 1_785_000_000 },
		},
		LedgerStore: git.NewFileStore(h.stateDir),
		// ⚠ THE SAME REASON AS THE LEDGER ABOVE, AND IT WAS LEARNED THE HARD WAY.
		// daemon.go leaves both nil so the real agent RESOLVES its state directory,
		// which on a developer machine is a live agent's — and this harness reaches a
		// `welcome`, so the breadcrumb it writes landed in that directory (measured:
		// this spec's host id and its httptest port ended up in ~/.local/state/pdmux
		// on the machine running the suite). Anything here that a real agent persists
		// has to be pointed at the temp directory the harness owns.
		LinkStore: state.NewLinkStore(h.stateDir),
		SpawnPTY:  func(term.Spec) (term.Process, error) { return newWiredPty(t), nil },
	})
	h.engine.SetPanes(h.agent.TerminalPanes)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := h.agent.Run(ctx); err != nil {
			t.Errorf("Run returned %v", err)
		}
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(wiredWait):
			t.Error("Run did not return after its context was cancelled")
		}
	})

	select {
	case h.conn = <-accepted:
	case <-time.After(wiredWait):
		t.Fatal("the agent never dialled")
	}
	h.waitFor("the hello frame", func() bool { return h.hello() != nil })
	return h
}

// abilityFor pairs the agent's `hello` with the engine's own refusal, the way
// daemon.go does by giving both the same probe. A build whose hello offers the
// button while its engine refuses it — or the reverse — is a dashboard that lies.
func abilityFor(opts Options) func() protocol.AgentUpdateAbility {
	if opts.Ability != nil {
		return opts.Ability
	}
	return func() protocol.AgentUpdateAbility { return Ability(opts.Env, opts.GOOS, os.Getppid()) }
}

func (h *wiredHarness) record(mutate func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	mutate()
}

// read drains the socket for the connection's whole life. Frames are DECODED,
// and therefore validated against the contract, here — so a spec that asserts on
// a phase has already proved the frame carrying it is legal.
func (h *wiredHarness) read(conn *websocket.Conn) {
	for {
		_, data, err := conn.Read(context.Background())
		if err != nil {
			return
		}
		frame, err := protocol.DecodeUpstream(data)
		if err != nil {
			h.t.Errorf("the agent sent a frame the contract rejects: %v (%s)", err, data)
			return
		}
		h.record(func() { h.frames = append(h.frames, frame) })
	}
}

func (h *wiredHarness) send(frame protocol.DownstreamFrame) {
	h.t.Helper()
	raw, err := protocol.EncodeDownstream(frame)
	if err != nil {
		h.t.Fatalf("encoding %T: %v", frame, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), wiredWait)
	defer cancel()
	if err := h.conn.Write(ctx, websocket.MessageText, raw); err != nil {
		h.t.Fatalf("writing %T: %v", frame, err)
	}
}

func (h *wiredHarness) welcome() {
	h.t.Helper()
	config := protocol.NewAgentConfig()
	// Both timers well out of the way: these specs are about the update path, and
	// a collector firing mid-swap is noise in the frame list.
	config.HeartbeatSec = 3_600
	config.GitIntervalSec = 3_600
	h.send(&protocol.WelcomeFrame{HostID: wiredHostID, Config: config, ServerVersion: "0.1.0-spec"})
}

// sendUpdate is the dashboard pressing the button.
func (h *wiredHarness) sendUpdate(mutate ...func(*protocol.AgentUpdate)) {
	h.t.Helper()
	update := protocol.NewAgentUpdate()
	update.CommandID = testCommand
	update.Version = "0.2.0"
	update.ArtifactPath = "/releases/pdmux-agent"
	sum := sha256.Sum256(h.artifact)
	update.SHA256 = hex.EncodeToString(sum[:])
	update.Bytes = int64(len(h.artifact))
	update.OS = "linux"
	update.Arch = "amd64"
	update.ProbationSec = 300
	for _, apply := range mutate {
		apply(&update)
	}
	h.send(&protocol.UpdateFrame{Update: update})
}

func (h *wiredHarness) openTerminal(termID string, kind protocol.TerminalKind) {
	h.t.Helper()
	target := protocol.NewTerminalTarget()
	target.Kind = kind
	target.Cols, target.Rows = 80, 24
	h.send(&protocol.TerminalDownstream{
		Frame: &protocol.TerminalOpen{Type: protocol.TermOpen, TermID: termID, Target: target},
	})
}

func (h *wiredHarness) statuses() []protocol.UpdateStatus {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []protocol.UpdateStatus
	for _, frame := range h.frames {
		if status, ok := frame.(*protocol.UpdateStatusFrame); ok {
			out = append(out, status.Update)
		}
	}
	return out
}

// statusIn returns the one status reported for a phase, or an empty one.
func (h *wiredHarness) statusIn(phase protocol.UpdatePhase) protocol.UpdateStatus {
	var found protocol.UpdateStatus
	for _, status := range h.statuses() {
		if status.Phase == phase {
			found = status
		}
	}
	return found
}

func (h *wiredHarness) reachedPhase(phase protocol.UpdatePhase) bool {
	return h.statusIn(phase).Phase == phase
}

func (h *wiredHarness) hello() *protocol.AgentHello {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, frame := range h.frames {
		if hello, ok := frame.(*protocol.HelloFrame); ok {
			return &hello.Hello
		}
	}
	return nil
}

func (h *wiredHarness) exitCodes() []int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]int(nil), h.exits...)
}

func (h *wiredHarness) waitFor(what string, predicate func() bool) {
	h.t.Helper()
	deadline := time.Now().Add(wiredWait)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.t.Fatalf("timed out waiting for %s", what)
}

// wiredPty is a pty a spec never drives: these specs only need panes to EXIST so
// they can be counted.
type wiredPty struct {
	output chan []byte
	exit   chan *int
	once   sync.Once
}

func newWiredPty(t *testing.T) *wiredPty {
	p := &wiredPty{output: make(chan []byte, 4), exit: make(chan *int, 1)}
	t.Cleanup(p.Kill)
	return p
}

func (p *wiredPty) Pid() *int             { pid := 4242; return &pid }
func (p *wiredPty) Write(string) error    { return nil }
func (p *wiredPty) Resize(_, _ int) error { return nil }
func (p *wiredPty) Output() <-chan []byte { return p.output }
func (p *wiredPty) Exit() <-chan *int     { return p.exit }
func (p *wiredPty) Kill() {
	p.once.Do(func() {
		close(p.output)
		p.exit <- nil
		close(p.exit)
	})
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

func TestWiredUpdate(t *testing.T) {
	t.Run("[TC-PDAGENT-073] an update frame reaches the engine and every phase comes back", func(t *testing.T) {
		h := startWired(t)
		h.welcome()
		h.sendUpdate()

		h.waitFor("the restarting phase", func() bool { return h.reachedPhase(protocol.PhaseRestarting) })

		// The frame reached THIS package and not the default decliner, which would
		// have answered `failed`/NOT_SUPPORTED without touching a single file.
		h.mu.Lock()
		ran, saw := h.verifyRan, h.verifySaw
		h.mu.Unlock()
		if ran != 1 {
			t.Fatalf("Gate 1 ran %d times, want exactly 1", ran)
		}
		if saw != oldBinary {
			t.Fatalf("at verify time the installed binary was %q, want the OLD one", saw)
		}
		if got := readFile(t, h.exe); got != newBinary {
			t.Fatalf("installed binary is %q, want the new one", got)
		}
		if _, ok, _ := readPending(h.engine.Dir()); !ok {
			t.Fatal("no probation marker: the new binary would start unprotected")
		}
		for _, phase := range []protocol.UpdatePhase{
			protocol.PhaseAccepted,
			protocol.PhaseDownloading,
			protocol.PhaseVerifying,
			protocol.PhaseSwapping,
			protocol.PhaseRestarting,
		} {
			if !h.reachedPhase(phase) {
				t.Fatalf("the server never saw %q; phases are what keep an update from being a silence", phase)
			}
		}
		final := h.statusIn(protocol.PhaseRestarting)
		if final.CommandID != testCommand {
			t.Fatalf("commandId = %q, want the one the server sent", final.CommandID)
		}
		if final.CurrentVersion != "0.1.0" || final.TargetVersion == nil || *final.TargetVersion != "0.2.0" {
			t.Fatalf("versions = %q -> %v", final.CurrentVersion, final.TargetVersion)
		}
		h.waitFor("the process to end so the service manager can start the new binary", func() bool {
			return len(h.exitCodes()) == 1
		})
		if codes := h.exitCodes(); codes[0] != 0 {
			t.Fatalf("exits = %v, want [0]", codes)
		}
	})

	// Untagged: pane accounting is new — the engine has always been able to report
	// a pair, but until now nothing counted them, so the warning read 0/0.
	t.Run("counts the panes a restart would end from the agent's own terminals", func(t *testing.T) {
		h := startWired(t)
		h.welcome()
		h.openTerminal("sh", protocol.TerminalShell)
		h.openTerminal("mux", protocol.TerminalSession)
		h.waitFor("both terminals to open", func() bool {
			shell, session := h.agent.TerminalPanes()
			return shell == 1 && session == 1
		})

		h.sendUpdate()
		h.waitFor("the accepted phase", func() bool { return h.reachedPhase(protocol.PhaseAccepted) })

		accepted := h.statusIn(protocol.PhaseAccepted)
		if accepted.ShellPanes != 1 || accepted.SessionPanes != 1 {
			t.Fatalf("accepted reported %d shell / %d session panes, want 1/1 — the dialog warns in these numbers",
				accepted.ShellPanes, accepted.SessionPanes)
		}
		// A warning, never a refusal: on a dev fleet something is always attached.
		h.waitFor("the update to proceed anyway", func() bool { return h.reachedPhase(protocol.PhaseRestarting) })
	})

	t.Run("[TC-PDAGENT-073] commits the update when `welcome` arrives, over that same socket", func(t *testing.T) {
		stateDir := t.TempDir()
		binDir := t.TempDir()
		exe := filepath.Join(binDir, "pdmux-agent")
		writeExecutable(t, exe, newBinary)
		writeExecutable(t, exe+".bak", oldBinary)
		// The state the swap leaves behind: a marker naming the version that is now
		// installed, and a deadline it has not reached.
		if err := writePending(filepath.Join(stateDir, "update"), Pending{
			CommandID:       testCommand,
			TargetVersion:   "0.2.0",
			PreviousVersion: "0.1.0",
			ExePath:         exe,
			BackupPath:      exe + ".bak",
			DeadlineUnix:    time.Now().Add(5 * time.Minute).Unix(),
		}); err != nil {
			t.Fatal(err)
		}

		h := startWired(t, func(s *wiredSetup) {
			s.stateDir, s.binDir, s.version = stateDir, binDir, "0.2.0"
		})
		if h.startup.Action != StartupProbation {
			t.Fatalf("startup action = %q, want probation", h.startup.Action)
		}
		// STARTING PROVES NOTHING. The socket is open and `hello` has been sent, and
		// the marker must still be armed: a build that connects and is refused looks
		// exactly like this until the welcome arrives.
		time.Sleep(wiredSettle)
		if _, ok, _ := readPending(h.engine.Dir()); !ok {
			t.Fatal("the marker was cleared before any handshake completed")
		}
		if len(h.statuses()) != 0 {
			t.Fatalf("statuses before the welcome: %+v", h.statuses())
		}

		h.welcome()
		h.waitFor("the `done` frame", func() bool { return h.reachedPhase(protocol.PhaseDone) })
		if _, ok, _ := readPending(h.engine.Dir()); ok {
			t.Fatal("a completed handshake must clear the marker, or the next restart rolls back a healthy agent")
		}
		done := h.statusIn(protocol.PhaseDone)
		if done.CommandID != testCommand {
			t.Fatalf("`done` carries commandId %q, want the original", done.CommandID)
		}
		if done.CurrentVersion != "0.2.0" {
			t.Fatalf("`done` reports currentVersion %q, want the version now running", done.CurrentVersion)
		}
	})

	t.Run("[TC-PDAGENT-073] a rollback taken before dialling is reported by the restored binary", func(t *testing.T) {
		stateDir := t.TempDir()
		binDir := t.TempDir()
		exe := filepath.Join(binDir, "pdmux-agent")
		writeExecutable(t, exe, newBinary)
		writeExecutable(t, exe+".bak", oldBinary)
		if err := writePending(filepath.Join(stateDir, "update"), Pending{
			CommandID:       testCommand,
			TargetVersion:   "0.2.0",
			PreviousVersion: "0.1.0",
			ExePath:         exe,
			BackupPath:      exe + ".bak",
			// Probation ended while the host was off.
			DeadlineUnix: time.Now().Add(-time.Minute).Unix(),
		}); err != nil {
			t.Fatal(err)
		}

		// The daemon's own first move, on the binary that is on trial: Startup, then
		// exit if it says so. Nothing dials, which is the point — the broken build
		// may not be able to.
		doomed := New(Options{ExePath: exe, StateDir: stateDir, Version: "0.2.0"})
		outcome := doomed.Startup()
		if outcome.Action != StartupRolledBack || !outcome.Exit {
			t.Fatalf("outcome = %+v, want a rollback that ends the process", outcome)
		}
		if got := readFile(t, exe); got != oldBinary {
			t.Fatalf("installed binary is %q, want the restored old one", got)
		}

		// The service manager starts what is installed now — the previous binary.
		h := startWired(t, func(s *wiredSetup) {
			s.stateDir, s.binDir, s.version = stateDir, binDir, "0.1.0"
		})
		if h.startup.Action != StartupNormal {
			t.Fatalf("the restored binary started as %q, want a normal start", h.startup.Action)
		}
		h.welcome()
		h.waitFor("the rolledBack frame", func() bool { return h.reachedPhase(protocol.PhaseRolledBack) })

		status := h.statusIn(protocol.PhaseRolledBack)
		if status.Code == nil || *status.Code != CodeProbationExpired {
			t.Fatalf("code = %v, want %s", status.Code, CodeProbationExpired)
		}
		if status.CurrentVersion != "0.1.0" || status.TargetVersion == nil || *status.TargetVersion != "0.2.0" {
			t.Fatalf("versions = %q -> %v", status.CurrentVersion, status.TargetVersion)
		}
	})

	t.Run("[TC-PDAGENT-074] refuses on a host nothing would restart, and its hello says so", func(t *testing.T) {
		// "Started from a terminal": no installer marker, no INVOCATION_ID, no
		// NOTIFY_SOCKET, and a parent that is a shell rather than launchd. The real
		// probe decides — Ability is left nil so nothing here can flatter it.
		h := startWired(t, func(s *wiredSetup) {
			s.tune = func(o *Options) { o.Ability = nil }
		})

		hello := h.hello()
		if hello.Update.CanRestart || hello.Update.RestartMode != protocol.RestartNone {
			t.Fatalf("hello.update = %+v, want the button hidden on a host with no supervisor", hello.Update)
		}

		h.welcome()
		h.sendUpdate()
		h.waitFor("the refusal", func() bool { return h.reachedPhase(protocol.PhaseFailed) })

		failed := h.statusIn(protocol.PhaseFailed)
		if failed.Code == nil || *failed.Code != CodeNoRestartSource {
			t.Fatalf("code = %v, want %s — exiting here is a hole the host never climbs out of",
				failed.Code, CodeNoRestartSource)
		}
		// Refused before ANY of it happened: nothing downloaded, nothing verified,
		// nothing installed, and above all nothing exited.
		h.mu.Lock()
		ran := h.verifyRan
		h.mu.Unlock()
		if ran != 0 {
			t.Fatalf("Gate 1 ran %d times on a host that cannot restart", ran)
		}
		if got := readFile(t, h.exe); got != oldBinary {
			t.Fatalf("installed binary is %q, want it untouched", got)
		}
		for _, stray := range []string{h.exe + ".new", h.exe + ".bak"} {
			if _, err := os.Stat(stray); err == nil {
				t.Fatalf("%s exists after a refusal", stray)
			}
		}
		time.Sleep(wiredSettle)
		if codes := h.exitCodes(); len(codes) != 0 {
			t.Fatalf("the agent exited %v on a host with nothing to start it again", codes)
		}
		if !strings.Contains(failed.Message, "service manager") {
			t.Fatalf("message %q does not say what is missing", failed.Message)
		}
	})
}
