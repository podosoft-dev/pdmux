package agent

// Runtime behaviour of the daemon itself: adopting configuration, remembering
// what the server acked, answering a click with a partial frame, and declining
// an update this build cannot perform.
//
// The specs drive a REAL WebSocket server, as internal/net's do. The TypeScript
// injected a socket factory because it had no cheap alternative; here the whole
// point of the file is that frames the server sends reach the collectors and
// come back, and a hand-written transport would be free to agree with the agent
// about all of it.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/podosoft-dev/pdmux/agent/internal/collect"
	"github.com/podosoft-dev/pdmux/agent/internal/git"
	"github.com/podosoft-dev/pdmux/agent/internal/log"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/state"
	"github.com/podosoft-dev/pdmux/agent/internal/term"
)

const (
	testHostID = "11111111-2222-4333-8444-555555555555"
	// waitFor bounds every blocking step, so a broken agent fails the test in
	// seconds instead of hanging the package until the go test timeout.
	waitFor = 5 * time.Second
	// settle is how long an assertion of ABSENCE waits before it believes itself.
	settle = 250 * time.Millisecond
)

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type savedLedger struct {
	hostID string
	repos  git.Repos
}

// memoryStore is the ledger's disk tier without a disk.
type memoryStore struct {
	mu      sync.Mutex
	initial git.Repos
	saves   []savedLedger
}

func (s *memoryStore) Load(string) git.Repos {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneRepos(s.initial)
}

func (s *memoryStore) Save(hostID string, repos git.Repos) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.saves = append(s.saves, savedLedger{hostID: hostID, repos: cloneRepos(repos)})
	return nil
}

func (s *memoryStore) Unavailable() bool { return false }

func (s *memoryStore) saved() []savedLedger {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]savedLedger(nil), s.saves...)
}

func cloneRepos(repos git.Repos) git.Repos {
	out := git.Repos{}
	for path, shas := range repos {
		out[path] = append([]string(nil), shas...)
	}
	return out
}

// fakePty is a pty a spec drives by hand. It honours the ordering contract
// term.Process states: Output closes before Exit delivers.
type fakePty struct {
	mu     sync.Mutex
	killed bool

	output chan []byte
	exit   chan *int
	once   sync.Once
}

func newFakePty() *fakePty {
	return &fakePty{output: make(chan []byte, 256), exit: make(chan *int, 1)}
}

func (f *fakePty) Pid() *int             { pid := 4242; return &pid }
func (f *fakePty) Write(string) error    { return nil }
func (f *fakePty) Resize(_, _ int) error { return nil }
func (f *fakePty) Output() <-chan []byte { return f.output }
func (f *fakePty) Exit() <-chan *int     { return f.exit }
func (f *fakePty) emit(chunk string)     { f.output <- []byte(chunk) }

func (f *fakePty) Kill() {
	f.mu.Lock()
	f.killed = true
	f.mu.Unlock()
	f.once.Do(func() {
		close(f.output)
		f.exit <- nil
		close(f.exit)
	})
}

func (f *fakePty) wasKilled() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.killed
}

// ---------------------------------------------------------------------------
// A server that speaks the contract
// ---------------------------------------------------------------------------

// session is one accepted agent connection, with everything it has sent.
type session struct {
	t    *testing.T
	conn *websocket.Conn

	mu     sync.Mutex
	frames []protocol.UpstreamFrame
}

// read drains the socket for the session's whole life. Frames are decoded (and
// therefore VALIDATED) here, so a spec that asserts on the last heartbeat has
// already proved every frame before it passed the contract.
func (s *session) read(ctx context.Context) {
	for {
		_, data, err := s.conn.Read(ctx)
		if err != nil {
			return
		}
		frame, err := protocol.DecodeUpstream(data)
		if err != nil {
			s.t.Errorf("the agent sent a frame the contract rejects: %v (%s)", err, data)
			return
		}
		s.mu.Lock()
		s.frames = append(s.frames, frame)
		s.mu.Unlock()
	}
}

func (s *session) send(frame protocol.DownstreamFrame) {
	s.t.Helper()
	raw, err := protocol.EncodeDownstream(frame)
	if err != nil {
		s.t.Fatalf("encoding %T: %v", frame, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), waitFor)
	defer cancel()
	if err := s.conn.Write(ctx, websocket.MessageText, raw); err != nil {
		s.t.Fatalf("writing %T: %v", frame, err)
	}
}

func (s *session) sent() []protocol.UpstreamFrame {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]protocol.UpstreamFrame(nil), s.frames...)
}

// forget drops what has been recorded so far, so an assertion is about what
// happened AFTER it rather than about the whole connection.
func (s *session) forget() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.frames = nil
}

type harness struct {
	t       *testing.T
	agent   *Agent
	store   *memoryStore
	pty     *fakePty
	session *session
	stop    context.CancelFunc
	done    chan struct{}
}

// start runs an agent against a live server and waits for its hello.
func start(t *testing.T, mutate func(*Options)) *harness {
	t.Helper()
	// Session targets resolve the multiplexer before the injected fake PTY is
	// opened. Supply a harmless executable so this harness behaves identically on
	// developer machines and minimal CI images without depending on system tmux.
	muxDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(muxDir, "tmux"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write fake tmux: %v", err)
	}
	t.Setenv("PATH", muxDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	store := &memoryStore{initial: git.Repos{}}
	pty := newFakePty()
	accepted := make(chan *session, 4)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		s := &session{t: t, conn: conn}
		go s.read(context.Background())
		accepted <- s
	}))

	// No real host is touched: the heartbeat pass has nothing to collect, and a
	// failed measurement is nil rather than zero.
	deps := collect.Deps{
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
	}
	options := Options{
		URL:           "ws" + strings.TrimPrefix(server.URL, "http") + protocol.AgentWSPath,
		Token:         "agent-token-value",
		Logger:        log.Silent(),
		Hostname:      "spec-host",
		Version:       "0.1.0-spec",
		HeartbeatDeps: &deps,
		LedgerStore:   store,
		// ⚠ NOT OPTIONAL, even for the specs that never look at it. Without a store
		// of its own the agent resolves the REAL state directory, and on a developer
		// machine that is a live agent's — every spec here would rewrite the link
		// breadcrumb of the host somebody is watching.
		LinkStore: state.NewLinkStore(t.TempDir()),
		SpawnPTY:  func(term.Spec) (term.Process, error) { return pty, nil },
	}
	if mutate != nil {
		mutate(&options)
	}

	agent := New(options)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := agent.Run(ctx); err != nil {
			t.Errorf("Run returned %v", err)
		}
	}()

	h := &harness{t: t, agent: agent, store: store, pty: pty, stop: cancel, done: done}
	select {
	case h.session = <-accepted:
	case <-time.After(waitFor):
		t.Fatal("the agent never dialled")
	}
	waitUntil(t, "the hello frame", func() bool {
		for _, frame := range h.session.sent() {
			if _, ok := frame.(*protocol.HelloFrame); ok {
				return true
			}
		}
		return false
	})

	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(waitFor):
			t.Error("Run did not return after its context was cancelled")
		}
		server.Close()
	})
	return h
}

// welcome hands the agent its identity and a configuration built from the
// contract's defaults, which is what `agentConfigSchema.parse({})` did.
func (h *harness) welcome(mutate func(*protocol.AgentConfig)) {
	h.t.Helper()
	h.session.send(&protocol.WelcomeFrame{
		HostID:        testHostID,
		Config:        testConfig(mutate),
		ServerVersion: "0.1.0-spec",
	})
}

// welcomeWithExpiry is the same frame plus the optional field a newer server
// sends. Separate from `welcome` so every existing case keeps proving what a
// server that says nothing produces.
func (h *harness) welcomeWithExpiry(expiresAt string) {
	h.t.Helper()
	h.session.send(&protocol.WelcomeFrame{
		HostID:         testHostID,
		Config:         testConfig(nil),
		ServerVersion:  "0.1.0-spec",
		TokenExpiresAt: &expiresAt,
	})
}

func testConfig(mutate func(*protocol.AgentConfig)) protocol.AgentConfig {
	config := protocol.NewAgentConfig()
	if mutate != nil {
		mutate(&config)
	}
	return config
}

func waitUntil(t *testing.T, what string, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(waitFor)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// diagnosticsOf is what the most recent heartbeat reported.
func diagnosticsOf(h *harness) []protocol.AgentDiagnostic {
	var latest []protocol.AgentDiagnostic
	for _, frame := range h.session.sent() {
		if beat, ok := frame.(*protocol.HeartbeatFrame); ok {
			latest = beat.Heartbeat.Diagnostics
		}
	}
	return latest
}

func hasDiagnostic(entries []protocol.AgentDiagnostic, code string) *protocol.AgentDiagnostic {
	for index := range entries {
		if entries[index].Code == code {
			return &entries[index]
		}
	}
	return nil
}

func countFrames[T protocol.UpstreamFrame](h *harness) int {
	count := 0
	for _, frame := range h.session.sent() {
		if _, ok := frame.(T); ok {
			count++
		}
	}
	return count
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

func TestConfigurationAdoption(t *testing.T) {
	t.Run("[TC-PDAGENT-042] takes every tuning knob from the server", func(t *testing.T) {
		h := start(t, nil)
		h.welcome(func(config *protocol.AgentConfig) {
			config.UsageIntervalSec = 300
			config.ProbeTimeoutMs = 750
			config.StatusFileCap = 25
			config.BodyMaxChars = 400
			config.TerminalBufferBytes = 8_192
		})

		waitUntil(t, "the configuration to be adopted", func() bool {
			return h.agent.UsageIntervalSec() == 300
		})
		config := h.agent.Config()
		if config.ProbeTimeoutMs != 750 || config.StatusFileCap != 25 || config.BodyMaxChars != 400 {
			t.Fatalf("config = %+v, want the server's values", config)
		}
		if got := h.agent.TerminalBufferBytes(); got != 8_192 {
			t.Fatalf("terminal buffer = %d, want the server's 8192", got)
		}
		if got := h.agent.HostID(); got != testHostID {
			t.Fatalf("hostId = %q, want the one the server assigned", got)
		}
	})

	t.Run("[TC-PDAGENT-042] adopts a later `config` frame without a reconnect", func(t *testing.T) {
		h := start(t, nil)
		h.welcome(func(config *protocol.AgentConfig) {
			config.TerminalBufferBytes = 8_192
			config.UsageIntervalSec = 30
		})
		waitUntil(t, "the first configuration", func() bool { return h.agent.UsageIntervalSec() == 30 })

		h.session.send(&protocol.ConfigFrame{Config: testConfig(func(config *protocol.AgentConfig) {
			config.TerminalBufferBytes = 1_048_576
			config.UsageIntervalSec = 600
		})})

		waitUntil(t, "the updated configuration", func() bool { return h.agent.UsageIntervalSec() == 600 })
		if got := h.agent.TerminalBufferBytes(); got != 1_048_576 {
			t.Fatalf("terminal buffer = %d, want the updated 1048576", got)
		}
		// The same socket carried both: a knob that needed a reconnect would be a
		// knob nobody turns on a host that is misbehaving right now.
		if !h.agent.client.Connected() {
			t.Fatal("adopting a config frame dropped the connection")
		}
	})

	t.Run("[TC-PDAGENT-042] applies the terminal buffer cap to a pane already open", func(t *testing.T) {
		h := start(t, nil)
		// 4096 is the contract's floor for this knob — the schema refuses less.
		h.welcome(func(config *protocol.AgentConfig) { config.TerminalBufferBytes = 4_096 })
		waitUntil(t, "the buffer cap", func() bool { return h.agent.TerminalBufferBytes() == 4_096 })

		target := protocol.NewTerminalTarget()
		target.Kind = protocol.TerminalShell
		target.Cols, target.Rows = 80, 24
		h.session.send(&protocol.TerminalDownstream{
			Frame: &protocol.TerminalOpen{Type: protocol.TermOpen, TermID: "t1", Target: target},
		})
		waitUntil(t, "the terminal to open", func() bool { return h.agent.terminals.Count() == 1 })

		// Far past the cap, faster than the relay flushes: the oldest bytes have to
		// go, and the pane is told how many.
		for range 40 {
			h.pty.emit(strings.Repeat("x", 500))
		}
		waitUntil(t, "the relay to report dropped bytes", func() bool { return droppedBytes(h) > 0 })
	})
}

// droppedBytes is what every output frame so far admitted to discarding.
func droppedBytes(h *harness) int {
	total := 0
	for _, frame := range h.session.sent() {
		wrapper, ok := frame.(*protocol.TerminalUpstream)
		if !ok {
			continue
		}
		if output, ok := wrapper.Frame.(*protocol.TerminalOutput); ok {
			total += output.Dropped
		}
	}
	return total
}

func TestDiagnosticsEndToEnd(t *testing.T) {
	t.Run("[TC-PDAGENT-043] surfaces a configured root that is not a checkout", func(t *testing.T) {
		notACheckout := t.TempDir()
		h := start(t, nil)
		// A one-second beat so the pass AFTER the git scan arrives promptly.
		h.welcome(func(config *protocol.AgentConfig) {
			config.GitRoots = []string{notACheckout}
			config.GitIntervalSec = 3_600
			config.HeartbeatSec = 1
		})

		// The git pass discovers it; the NEXT heartbeat reports it.
		waitUntil(t, "the git.root_missing diagnostic", func() bool {
			return hasDiagnostic(diagnosticsOf(h), collect.CodeGitRootMissing) != nil
		})
		entry := hasDiagnostic(diagnosticsOf(h), collect.CodeGitRootMissing)
		if entry.Level != protocol.DiagnosticWarn {
			t.Fatalf("level = %q, want warn", entry.Level)
		}
		if !strings.Contains(entry.Message, notACheckout) {
			t.Fatalf("message %q does not name the configured root", entry.Message)
		}
	})

	t.Run("[TC-PDAGENT-044] clears the diagnostic once the root is no longer configured", func(t *testing.T) {
		notACheckout := t.TempDir()
		h := start(t, nil)
		h.welcome(func(config *protocol.AgentConfig) {
			config.GitRoots = []string{notACheckout}
			config.GitIntervalSec = 3_600
			config.HeartbeatSec = 1
		})
		waitUntil(t, "the git.root_missing diagnostic", func() bool {
			return hasDiagnostic(diagnosticsOf(h), collect.CodeGitRootMissing) != nil
		})

		h.session.send(&protocol.ConfigFrame{Config: testConfig(func(config *protocol.AgentConfig) {
			config.HeartbeatSec = 1
		})})
		h.session.forget()
		h.session.send(&protocol.CollectFrame{What: protocol.CollectHeartbeat})

		waitUntil(t, "a heartbeat under the new configuration", func() bool {
			return countFrames[*protocol.HeartbeatFrame](h) > 0
		})
		if entry := hasDiagnostic(diagnosticsOf(h), collect.CodeGitRootMissing); entry != nil {
			t.Fatalf("still reporting a root nobody configured: %q", entry.Message)
		}
	})
}

func TestDetailAcknowledgement(t *testing.T) {
	t.Run("[TC-PDAGENT-036] persists what the server says it stored", func(t *testing.T) {
		h := start(t, nil)
		h.welcome(nil)
		waitUntil(t, "the welcome to be adopted", func() bool { return h.agent.HostID() == testHostID })

		h.session.send(&protocol.DetailAckFrame{
			RepoPath: "/srv/demo",
			Shas:     []string{"abcdef1234567", "bbbbbbbbbbbbb"},
		})

		waitUntil(t, "the ledger to be written", func() bool { return len(h.store.saved()) == 1 })
		saved := h.store.saved()[0]
		if saved.hostID != testHostID {
			t.Fatalf("saved under host %q, want %q", saved.hostID, testHostID)
		}
		if got := saved.repos["/srv/demo"]; !equalStrings(got, []string{"abcdef1234567", "bbbbbbbbbbbbb"}) {
			t.Fatalf("saved shas = %v, want both acked ones", got)
		}
	})

	t.Run("[TC-PDAGENT-036] loads the acked ledger for this host on welcome", func(t *testing.T) {
		h := start(t, nil)
		h.store.mu.Lock()
		h.store.initial = git.Repos{"/srv/demo": {"abcdef1234567"}}
		h.store.mu.Unlock()

		h.welcome(nil)
		waitUntil(t, "the welcome to be adopted", func() bool { return h.agent.HostID() == testHostID })
		h.session.send(&protocol.DetailAckFrame{RepoPath: "/srv/demo", Shas: []string{"bbbbbbbbbbbbb"}})

		// A second ack for the same repo must carry the LOADED shas too, otherwise
		// a restart would quietly forget everything acked before it.
		waitUntil(t, "the ledger to be written", func() bool { return len(h.store.saved()) == 1 })
		if got := h.store.saved()[0].repos["/srv/demo"]; !equalStrings(got, []string{"abcdef1234567", "bbbbbbbbbbbbb"}) {
			t.Fatalf("saved shas = %v, want the loaded one and the new one", got)
		}
	})

	t.Run("[TC-PDAGENT-039] ignores a detail request for a repo it does not have", func(t *testing.T) {
		h := start(t, nil)
		h.welcome(nil)
		waitUntil(t, "the welcome to be adopted", func() bool { return h.agent.HostID() == testHostID })

		// The path comes from the server. Answering it would mean running git in a
		// directory this agent never discovered.
		h.session.send(&protocol.CommitDetailFrame{
			RepoPath: "/not/discovered",
			Shas:     []string{"abcdef1234567"},
		})

		time.Sleep(settle)
		if count := countFrames[*protocol.ReposFrame](h); count != 0 {
			t.Fatalf("answered an unknown repo with %d repos frame(s)", count)
		}
	})
}

// Untagged: the git pass itself is pinned by internal/git's specs and by the
// round-trip spec below (TestLiveRoundTrip, TC-PDAGENT-035); what is only
// testable here is the WIRING — that a configured root becomes a `repos` frame
// on this socket.
func TestGitPass(t *testing.T) {
	t.Run("ships a snapshot of every configured checkout", func(t *testing.T) {
		if _, err := exec.LookPath("git"); err != nil {
			// "No git installed" is a fact this agent reports rather than a defect.
			t.Skip("git is not installed; this pass needs a real checkout")
		}
		// A developer's own ~/.gitconfig would otherwise change what the pass sees.
		t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
		t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
		root := t.TempDir()
		repo := filepath.Join(root, "demo")
		if err := os.Mkdir(repo, 0o755); err != nil {
			t.Fatalf("creating the checkout: %v", err)
		}
		gitSetup(t, repo, "init", "-b", "main")
		if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("pdmux\n"), 0o644); err != nil {
			t.Fatalf("writing a file: %v", err)
		}
		gitSetup(t, repo, "add", "README.md")
		gitSetup(t, repo, "commit", "-m", "first")

		h := start(t, nil)
		h.welcome(func(config *protocol.AgentConfig) {
			config.GitRoots = []string{root}
			// Both intervals out of the way: this spec is about the pass `welcome`
			// starts, not about a timer.
			config.GitIntervalSec = 3_600
			config.HeartbeatSec = 3_600
		})

		waitUntil(t, "a repos frame for the configured root", func() bool {
			return countFrames[*protocol.ReposFrame](h) > 0
		})
		var snapshot protocol.RepoSnapshot
		for _, frame := range h.session.sent() {
			if repos, ok := frame.(*protocol.ReposFrame); ok && len(repos.Repos) > 0 {
				snapshot = repos.Repos[0]
			}
		}
		if snapshot.Name != "demo" {
			t.Fatalf("snapshot.name = %q, want the checkout's directory", snapshot.Name)
		}
		if snapshot.Error != nil {
			t.Fatalf("snapshot carried an error: %q", *snapshot.Error)
		}
		if len(snapshot.Commits) == 0 {
			t.Fatal("the snapshot has no commit rows")
		}
		if snapshot.Partial {
			t.Fatal("a scheduled pass sent a partial snapshot; partial is for a click")
		}
		// The root exists and is a checkout, so nothing may be reported missing.
		if entry := hasDiagnostic(diagnosticsOf(h), collect.CodeGitRootMissing); entry != nil {
			t.Fatalf("a healthy root was reported missing: %q", entry.Message)
		}
	})

	t.Run("estimates a batch by the patch lines that dominate it", func(t *testing.T) {
		// The estimate only has to decide when to flush, so it counts the one thing
		// that can make a frame a megabyte.
		bare := protocol.NewRepoSnapshot()
		withPatch := protocol.NewRepoSnapshot()
		detail := protocol.NewCommitDetail()
		file := protocol.NewDiffFile()
		file.Lines = []string{"+one", "+two"}
		detail.Files = []protocol.DiffFile{file}
		withPatch.Details = []protocol.CommitDetail{detail}

		if got, want := estimateBytes(bare), 512; got != want {
			t.Fatalf("empty snapshot = %d bytes, want the %d-byte floor", got, want)
		}
		if got, want := estimateBytes(withPatch), 512+len("+one")+1+len("+two")+1; got != want {
			t.Fatalf("snapshot with two patch lines = %d bytes, want %d", got, want)
		}
	})
}

// The whole conversation in one pass, in the order a real host has it: dial and
// say hello, be welcomed, report a heartbeat, answer a ping, and collect on
// demand.
//
// Every other spec in this package proves ONE of those against the same live
// socket. This one exists because a suite of green units still says nothing about
// the sequence: an agent that heartbeats only after a `collect`, or that stops
// answering pings once the git pass has run, passes all of them. The TypeScript
// agent needed a separate `test/smoke.test.ts` and a hand-written stub server for
// this; here the package's own harness already IS a server that speaks the
// contract, so the sequence is asserted where the other behaviour is.
func TestLiveRoundTrip(t *testing.T) {
	t.Run("[TC-PDAGENT-035] hello, welcome, heartbeat, ping-pong and collect on one socket", func(t *testing.T) {
		if _, err := exec.LookPath("git"); err != nil {
			t.Skip("git is not installed; the collect leg of this round trip needs a real checkout")
		}
		// A developer's own ~/.gitconfig would otherwise change what the pass sees.
		t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
		t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
		root := t.TempDir()
		repo := filepath.Join(root, "demo")
		if err := os.Mkdir(repo, 0o755); err != nil {
			t.Fatalf("creating the checkout: %v", err)
		}
		gitSetup(t, repo, "init", "-b", "main")
		if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("pdmux\n"), 0o644); err != nil {
			t.Fatalf("writing a file: %v", err)
		}
		gitSetup(t, repo, "add", "README.md")
		gitSetup(t, repo, "commit", "-m", "first")

		// 1. hello — start() does not return until the frame is on the wire.
		h := start(t, nil)

		// 2. welcome — the identity is adopted, so the agent knows whose ledger it
		//    is keeping. Both timers are pushed out of the way: what follows must be
		//    the answer to a frame, never a tick that happened to land.
		h.welcome(func(config *protocol.AgentConfig) {
			config.GitRoots = []string{root}
			config.GitIntervalSec = 3_600
			config.HeartbeatSec = 3_600
		})
		waitUntil(t, "the welcome to be adopted", func() bool { return h.agent.HostID() == testHostID })

		// 3. heartbeat — welcome starts the collection pass, and the session decodes
		//    every frame, so arriving at all means it passed the contract.
		waitUntil(t, "the first heartbeat", func() bool {
			return countFrames[*protocol.HeartbeatFrame](h) > 0
		})

		// 4. ping -> pong. Scoped with forget() so the pong is provably an answer to
		//    THIS ping rather than a frame from earlier in the connection.
		h.session.forget()
		h.session.send(&protocol.PingFrame{Ts: 1_785_000_042})
		waitUntil(t, "a pong", func() bool { return countFrames[*protocol.PongFrame](h) > 0 })

		// 5. collect — an on-demand pass reaches the configured checkout. This is
		//    the leg that proves the frames are wired to the collectors and not just
		//    to the socket.
		h.session.forget()
		h.session.send(&protocol.CollectFrame{What: protocol.CollectRepos})
		waitUntil(t, "a repos frame for the configured root", func() bool {
			return countFrames[*protocol.ReposFrame](h) > 0
		})
		var snapshot protocol.RepoSnapshot
		for _, frame := range h.session.sent() {
			if repos, ok := frame.(*protocol.ReposFrame); ok && len(repos.Repos) > 0 {
				snapshot = repos.Repos[0]
			}
		}
		if snapshot.Name != "demo" {
			t.Fatalf("snapshot.name = %q, want the checkout's directory", snapshot.Name)
		}
		if snapshot.Error != nil {
			t.Fatalf("snapshot carried an error: %q", *snapshot.Error)
		}
		if len(snapshot.Commits) == 0 {
			t.Fatal("the on-demand pass returned a snapshot with no commit rows")
		}
	})
}

func gitSetup(t *testing.T, repo string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = repo
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=pdmux spec",
		"GIT_AUTHOR_EMAIL=spec@pdmux.test",
		"GIT_COMMITTER_NAME=pdmux spec",
		"GIT_COMMITTER_EMAIL=spec@pdmux.test",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
}

// The update seam is new: the TypeScript agent handled neither `update` nor
// `updateStatus`, so these carry no TC id. Phase 6 replaces the handler, not the
// routing, and these specs are what pin that boundary.
func TestRemoteUpdateSeam(t *testing.T) {
	t.Run("declines an update this build cannot perform, rather than going silent", func(t *testing.T) {
		h := start(t, nil)
		h.welcome(nil)
		waitUntil(t, "the welcome to be adopted", func() bool { return h.agent.HostID() == testHostID })

		h.session.send(&protocol.UpdateFrame{Update: newUpdate()})

		waitUntil(t, "an updateStatus reply", func() bool {
			return countFrames[*protocol.UpdateStatusFrame](h) > 0
		})
		status := lastStatus(h)
		if status.Phase != protocol.PhaseFailed {
			t.Fatalf("phase = %q, want failed", status.Phase)
		}
		if status.Code == nil || *status.Code != UpdateCodeNotSupported {
			t.Fatalf("code = %v, want %q so the dashboard can group it", status.Code, UpdateCodeNotSupported)
		}
		// Echoed, so a retry of the same command is recognisable as the same job.
		if status.CommandID != newUpdate().CommandID {
			t.Fatalf("commandId = %q, want the one the server sent", status.CommandID)
		}
		if status.CurrentVersion != "0.1.0-spec" {
			t.Fatalf("currentVersion = %q, want what is actually running", status.CurrentVersion)
		}
	})

	t.Run("hands the frame to an injected handler", func(t *testing.T) {
		seen := make(chan protocol.AgentUpdate, 1)
		h := start(t, func(options *Options) {
			options.Update = updaterFunc(func(_ context.Context, request UpdateRequest) {
				seen <- request.Update
				status := protocol.NewUpdateStatus()
				status.CommandID = request.Update.CommandID
				status.Phase = protocol.PhaseAccepted
				status.CurrentVersion = request.CurrentVersion
				request.Report(status)
			})
		})
		h.welcome(nil)
		h.session.send(&protocol.UpdateFrame{Update: newUpdate()})

		select {
		case update := <-seen:
			if update.SHA256 != newUpdate().SHA256 {
				t.Fatalf("the handler saw sha256 %q", update.SHA256)
			}
		case <-time.After(waitFor):
			t.Fatal("the update frame never reached the handler")
		}
		waitUntil(t, "the handler's status to reach the server", func() bool {
			return countFrames[*protocol.UpdateStatusFrame](h) > 0
		})
		if got := lastStatus(h).Phase; got != protocol.PhaseAccepted {
			t.Fatalf("phase = %q, want the handler's accepted", got)
		}
	})

	t.Run("[TC-PDAGENT-073] commits a self-update at welcome, and only at welcome", func(t *testing.T) {
		// The commit point of an update is a COMPLETED HANDSHAKE, not this process
		// having started: a binary that starts and cannot connect is the failure the
		// probation marker exists to catch. This spec pins the call site; the engine
		// behaviour it reaches is internal/update's.
		committer := &stubCommitter{}
		h := start(t, func(options *Options) { options.Update = committer })

		// The socket is open and `hello` has been sent — and that must not be enough.
		time.Sleep(settle)
		if got := committer.count(); got != 0 {
			t.Fatalf("the updater was told it had connected %d times before any welcome", got)
		}

		h.welcome(nil)
		waitUntil(t, "the commit point", func() bool { return committer.count() == 1 })
		waitUntil(t, "the committed outcome to reach the server", func() bool {
			return countFrames[*protocol.UpdateStatusFrame](h) > 0
		})
		status := lastStatus(h)
		if status.Phase != protocol.PhaseDone {
			t.Fatalf("phase = %q, want the committer's done", status.Phase)
		}
		if status.CommandID != newUpdate().CommandID {
			t.Fatalf("commandId = %q, want the one the update carried", status.CommandID)
		}
	})

	t.Run("[TC-PDAGENT-114] writes the breadcrumb at welcome, and not before", func(t *testing.T) {
		// Same commit point as the update marker above and for the same reason: an
		// open socket is not acceptance, and a file that said it was would report an
		// agent being refused every five seconds as a healthy one.
		dir := t.TempDir()
		links := state.NewLinkStore(dir)
		h := start(t, func(options *Options) { options.LinkStore = links })

		time.Sleep(settle)
		if _, ok, _ := links.Read(); ok {
			t.Fatal("the breadcrumb was written before any welcome arrived")
		}

		h.welcome(nil)
		waitUntil(t, "the breadcrumb", func() bool {
			link, ok, _ := links.Read()
			return ok && link.LastConnectedAt > 0
		})
		link, _, err := links.Read()
		if err != nil {
			t.Fatal(err)
		}
		if link.HostID != testHostID {
			t.Fatalf("hostId = %q, want the one welcome assigned", link.HostID)
		}
		if link.Server != h.agent.serverURL {
			t.Fatalf("server = %q, want the endpoint this agent dials", link.Server)
		}
		// ⚠ The one thing this file must never hold. It is read by another command
		// by design, so a credential in it is a credential in that command's output.
		raw, err := os.ReadFile(filepath.Join(dir, state.LinkFile))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(raw), "agent-token-value") {
			t.Fatalf("the token reached the breadcrumb:\n%s", raw)
		}
	})

	t.Run("[TC-PDAGENT-114] records when the credential lapses, and only if told", func(t *testing.T) {
		// ⚠ THE POINT IS TO WARN BEFORE THE 401, NOT AFTER. Once a token expires the
		// only symptom is a refusal that looks exactly like every other refusal, so
		// the expiry has to be on disk while the agent is still healthy.
		expiresAt := time.Now().Add(72 * time.Hour).UTC().Truncate(time.Second)
		links := state.NewLinkStore(t.TempDir())
		h := start(t, func(options *Options) { options.LinkStore = links })

		h.welcomeWithExpiry(expiresAt.Format(time.RFC3339))
		waitUntil(t, "the breadcrumb", func() bool {
			link, ok, _ := links.Read()
			return ok && link.LastConnectedAt > 0
		})
		link, _, _ := links.Read()
		if link.TokenExpiresAt != expiresAt.Unix() {
			t.Fatalf("tokenExpiresAt = %d, want %d", link.TokenExpiresAt, expiresAt.Unix())
		}
	})

	t.Run("[TC-PDAGENT-114] a server that says nothing leaves the field out", func(t *testing.T) {
		// The control, and the compatibility case. A token minted without an expiry
		// and a server too old to mention one both arrive as nothing — writing 0 for
		// either would put an expiry in 1970 into the file and make a perfectly
		// healthy agent read as one whose credential lapsed long ago.
		links := state.NewLinkStore(t.TempDir())
		h := start(t, func(options *Options) { options.LinkStore = links })

		h.welcome(nil)
		waitUntil(t, "the breadcrumb", func() bool {
			link, ok, _ := links.Read()
			return ok && link.LastConnectedAt > 0
		})
		link, _, _ := links.Read()
		if link.TokenExpiresAt != 0 {
			t.Fatalf("tokenExpiresAt = %d, want it absent", link.TokenExpiresAt)
		}
	})

	t.Run("[TC-PDAGENT-114] a date this build cannot read is left out, not guessed", func(t *testing.T) {
		// A future server could change the encoding. Recording a wrong instant is
		// worse than recording none: `instances` would announce an expiry that is
		// not real, and somebody would rotate a credential that was fine.
		//
		// ⚠ THIS ASSERTS THE OUTCOME, NOT ONE GUARD, and it is written that way on
		// purpose after the parse check was removed and this case still passed. Two
		// layers produce it: the caller drops the field on a parse error, and the
		// store refuses a non-positive value (`time.Parse` failing hands back the
		// ZERO time, whose Unix() is a large negative number, not a nothing). The
		// store's half is where a removal is actually caught — see
		// state/link_test.go, which fails when that guard goes.
		links := state.NewLinkStore(t.TempDir())
		h := start(t, func(options *Options) { options.LinkStore = links })

		h.welcomeWithExpiry("not-a-timestamp")
		waitUntil(t, "the breadcrumb", func() bool {
			link, ok, _ := links.Read()
			return ok && link.LastConnectedAt > 0
		})
		link, _, _ := links.Read()
		if link.TokenExpiresAt != 0 {
			t.Fatalf("tokenExpiresAt = %d, want it absent", link.TokenExpiresAt)
		}
	})

	t.Run("hello says this host cannot restart itself", func(t *testing.T) {
		// The default must read as "do not offer the button": an update ends with
		// the agent exiting, and with nothing to start it again that is a hole the
		// host never climbs out of.
		h := start(t, nil)
		var hello *protocol.HelloFrame
		for _, frame := range h.session.sent() {
			if candidate, ok := frame.(*protocol.HelloFrame); ok {
				hello = candidate
			}
		}
		if hello == nil {
			t.Fatal("no hello frame was recorded")
		}
		if hello.Hello.Update.CanRestart {
			t.Fatal("canRestart is true without a probe that says so")
		}
		if hello.Hello.Update.RestartMode != protocol.RestartNone {
			t.Fatalf("restartMode = %q, want none", hello.Hello.Update.RestartMode)
		}
		if hello.Hello.AgentVersion != "0.1.0-spec" {
			t.Fatalf("agentVersion = %q, want the injected build version", hello.Hello.AgentVersion)
		}
	})

	t.Run("an injected probe decides what hello claims", func(t *testing.T) {
		// The shape Phase 6 plugs into: the ability is a probe, not a constant.
		h := start(t, func(options *Options) {
			options.UpdateAbility = func() protocol.AgentUpdateAbility {
				return protocol.AgentUpdateAbility{CanRestart: true, RestartMode: protocol.RestartSystemd}
			}
		})
		for _, frame := range h.session.sent() {
			if hello, ok := frame.(*protocol.HelloFrame); ok {
				if !hello.Hello.Update.CanRestart || hello.Hello.Update.RestartMode != protocol.RestartSystemd {
					t.Fatalf("hello.update = %+v, want the probe's answer", hello.Hello.Update)
				}
				return
			}
		}
		t.Fatal("no hello frame was recorded")
	})
}

// Untagged: pane accounting is new. It is what lets the dashboard warn in
// numbers before a restart — shells and their children end, sessions re-attach —
// and no existing TC covers it.
func TestTerminalPanes(t *testing.T) {
	t.Run("reports what a restart would cost, by kind", func(t *testing.T) {
		h := start(t, nil)
		h.welcome(nil)

		if shell, session := h.agent.TerminalPanes(); shell != 0 || session != 0 {
			t.Fatalf("panes = %d/%d with nothing open", shell, session)
		}

		shellTarget := protocol.NewTerminalTarget()
		shellTarget.Kind = protocol.TerminalShell
		shellTarget.Cols, shellTarget.Rows = 80, 24
		sessionTarget := protocol.NewTerminalTarget()
		sessionTarget.Kind = protocol.TerminalSession
		sessionTarget.Cols, sessionTarget.Rows = 80, 24
		h.session.send(&protocol.TerminalDownstream{
			Frame: &protocol.TerminalOpen{Type: protocol.TermOpen, TermID: "sh", Target: shellTarget},
		})
		h.session.send(&protocol.TerminalDownstream{
			Frame: &protocol.TerminalOpen{Type: protocol.TermOpen, TermID: "mux", Target: sessionTarget},
		})
		waitUntil(t, "both terminals to open", func() bool { return h.agent.terminals.Count() == 2 })

		shell, session := h.agent.TerminalPanes()
		if shell != 1 || session != 1 {
			t.Fatalf("panes = %d shell / %d session, want 1/1 — the update warning is these numbers", shell, session)
		}
	})
}

// Untagged: the guard is ported behaviour that no existing TC pins on its own.
func TestPassLifecycle(t *testing.T) {
	t.Run("refuses to start a second pass while one is in flight", func(t *testing.T) {
		var passes atomic.Int32
		release := make(chan struct{})
		deps := collect.Deps{
			Sessions: func(context.Context) collect.SessionReading {
				passes.Add(1)
				<-release
				return collect.SessionReading{Sessions: []protocol.MuxSession{}, Present: true}
			},
			Now: func() int64 { return 1_785_000_000 },
		}
		// No welcome: the timers stay stopped, so the only passes are the ones
		// these `collect` frames ask for.
		h := start(t, func(options *Options) { options.HeartbeatDeps = &deps })
		h.session.send(&protocol.CollectFrame{What: protocol.CollectHeartbeat})
		waitUntil(t, "the first pass to start", func() bool { return passes.Load() == 1 })

		h.session.send(&protocol.CollectFrame{What: protocol.CollectHeartbeat})
		// Overlapping passes would queue probes behind each other until the agent
		// is doing nothing but collecting.
		time.Sleep(settle)
		if got := passes.Load(); got != 1 {
			t.Fatalf("%d passes ran concurrently, want 1", got)
		}
		close(release)
		waitUntil(t, "the pass to ship its heartbeat", func() bool {
			return countFrames[*protocol.HeartbeatFrame](h) == 1
		})
	})

	t.Run("shuts down cleanly, taking the ptys with it", func(t *testing.T) {
		h := start(t, nil)
		h.welcome(nil)
		target := protocol.NewTerminalTarget()
		target.Kind = protocol.TerminalShell
		target.Cols, target.Rows = 80, 24
		h.session.send(&protocol.TerminalDownstream{
			Frame: &protocol.TerminalOpen{Type: protocol.TermOpen, TermID: "t1", Target: target},
		})
		waitUntil(t, "the terminal to open", func() bool { return h.agent.terminals.Count() == 1 })

		h.stop()
		select {
		case <-h.done:
		case <-time.After(waitFor):
			t.Fatal("Run did not return after its context was cancelled")
		}
		if !h.pty.wasKilled() {
			t.Fatal("the pty outlived the agent that owned it")
		}
	})
}

// ---------------------------------------------------------------------------
// Spec helpers
// ---------------------------------------------------------------------------

// updaterFunc adapts a function to UpdateHandler, the way http.HandlerFunc does.
type updaterFunc func(ctx context.Context, request UpdateRequest)

func (f updaterFunc) HandleUpdate(ctx context.Context, request UpdateRequest) { f(ctx, request) }

// stubCommitter is an updater that also has something to commit — the shape
// internal/update's Engine takes, without its filesystem.
type stubCommitter struct {
	mu    sync.Mutex
	calls int
}

func (s *stubCommitter) HandleUpdate(context.Context, UpdateRequest) {}

func (s *stubCommitter) Connected(report func(protocol.UpdateStatus)) {
	s.mu.Lock()
	s.calls++
	s.mu.Unlock()
	status := protocol.NewUpdateStatus()
	status.CommandID = newUpdate().CommandID
	status.Phase = protocol.PhaseDone
	status.CurrentVersion = "0.1.0-spec"
	target := newUpdate().Version
	status.TargetVersion = &target
	status.Message = "updated"
	report(status)
}

func (s *stubCommitter) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

// newUpdate is one legal `update` payload. The artifact is a PATH, never a URL —
// the agent joins it onto the origin in its own config.
func newUpdate() protocol.AgentUpdate {
	update := protocol.NewAgentUpdate()
	update.CommandID = "22222222-3333-4444-8555-666666666666"
	update.Version = "0.2.0"
	update.ArtifactPath = "/downloads/pdmux-agent-0.2.0-linux-amd64"
	update.SHA256 = strings.Repeat("ab", 32)
	update.Bytes = 12_345
	update.OS = "linux"
	update.Arch = "amd64"
	return update
}

func lastStatus(h *harness) protocol.UpdateStatus {
	var latest protocol.UpdateStatus
	for _, frame := range h.session.sent() {
		if status, ok := frame.(*protocol.UpdateStatusFrame); ok {
			latest = status.Update
		}
	}
	return latest
}

func equalStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}

// framesOf collects every upstream frame of one type, so a spec can assert on
// the contents rather than only the count.
func framesOf[T protocol.UpstreamFrame](h *harness) []T {
	var found []T
	for _, frame := range h.session.sent() {
		if typed, ok := frame.(T); ok {
			found = append(found, typed)
		}
	}
	return found
}

// Running a command is the only thing the agent does that changes the host, so
// the specs are about the promises around it rather than about `sys.Run`, which
// has its own.
func TestExec(t *testing.T) {
	t.Run("[TC-PDMCP-003] runs the command and reports the exit code, not just the output", func(t *testing.T) {
		h := start(t, nil)
		h.welcome(nil)
		waitUntil(t, "the welcome to be adopted", func() bool { return h.agent.HostID() == testHostID })

		command := protocol.NewAgentExec()
		command.CommandID = "00000000-0000-4000-8000-00000000000a"
		command.Command = "sh"
		command.Args = []string{"-c", "printf out; printf err >&2; exit 3"}
		command.TimeoutMs = 5_000
		h.session.send(&protocol.ExecFrame{Exec: command})

		waitUntil(t, "the result to come back", func() bool { return len(framesOf[*protocol.ExecResultFrame](h)) == 1 })
		got := framesOf[*protocol.ExecResultFrame](h)[0].Result
		// The exit code is the entire reason this is not a terminal session.
		if got.ExitCode != 3 {
			t.Fatalf("exitCode = %d, want 3", got.ExitCode)
		}
		if got.Stdout != "out" || got.Stderr != "err" {
			t.Fatalf("stdout/stderr = %q/%q, want \"out\"/\"err\"", got.Stdout, got.Stderr)
		}
		if got.CommandID != "00000000-0000-4000-8000-00000000000a" {
			t.Fatalf("commandId = %q, want the one that was asked for", got.CommandID)
		}
		if got.TimedOut || got.Truncated || got.Code != nil {
			t.Fatalf("result = %+v, want a plain completed run", got)
		}
	})

	t.Run("[TC-PDMCP-003] treats the argument list as data, never as a shell line", func(t *testing.T) {
		// If anything assembled a command line, the `;` would start a second command
		// and `touch` would create the file. It has to arrive as one argument.
		h := start(t, nil)
		h.welcome(nil)
		waitUntil(t, "the welcome to be adopted", func() bool { return h.agent.HostID() == testHostID })

		marker := filepath.Join(t.TempDir(), "injected")
		command := protocol.NewAgentExec()
		command.CommandID = "00000000-0000-4000-8000-00000000000b"
		command.Command = "echo"
		command.Args = []string{"safe; touch " + marker}
		command.TimeoutMs = 5_000
		h.session.send(&protocol.ExecFrame{Exec: command})

		waitUntil(t, "the result to come back", func() bool { return len(framesOf[*protocol.ExecResultFrame](h)) == 1 })
		if _, err := os.Stat(marker); err == nil {
			t.Fatal("the argument reached a shell: it created a file")
		}
		got := framesOf[*protocol.ExecResultFrame](h)[0].Result
		if !strings.Contains(got.Stdout, "safe; touch") {
			t.Fatalf("stdout = %q, want the whole argument echoed back verbatim", got.Stdout)
		}
	})

	t.Run("[TC-PDMCP-003] answers a missing binary with a reason a caller can act on", func(t *testing.T) {
		h := start(t, nil)
		h.welcome(nil)
		waitUntil(t, "the welcome to be adopted", func() bool { return h.agent.HostID() == testHostID })

		command := protocol.NewAgentExec()
		command.CommandID = "00000000-0000-4000-8000-00000000000c"
		command.Command = "pdmux-definitely-not-installed"
		command.TimeoutMs = 5_000
		h.session.send(&protocol.ExecFrame{Exec: command})

		// Silence is the one outcome that would leave a caller blocked forever, so
		// even "there is no such command" is a frame.
		waitUntil(t, "the result to come back", func() bool { return len(framesOf[*protocol.ExecResultFrame](h)) == 1 })
		got := framesOf[*protocol.ExecResultFrame](h)[0].Result
		if got.Code == nil || *got.Code != "COMMAND_NOT_FOUND" {
			t.Fatalf("code = %v, want COMMAND_NOT_FOUND", got.Code)
		}
		if got.ExitCode != -1 {
			t.Fatalf("exitCode = %d, want -1 for a command that never started", got.ExitCode)
		}
	})

	t.Run("[TC-PDMCP-003] finds a binary a service manager's PATH does not carry", func(t *testing.T) {
		// ⚠ A SERVICE MANAGER'S PATH IS NOT A PERSON'S. launchd hands the agent neither
		// homebrew prefix and systemd omits a user's own installs, so a plain PATH lookup
		// answers COMMAND_NOT_FOUND for binaries the host plainly has — which is how the
		// pane scroll control would fail on a Mac while `tmux` sat in /opt/homebrew/bin.
		home := t.TempDir()
		binDir := filepath.Join(home, ".local", "bin")
		if err := os.MkdirAll(binDir, 0o755); err != nil {
			t.Fatal(err)
		}
		script := filepath.Join(binDir, "pdmux-offpath-probe")
		if err := os.WriteFile(script, []byte("#!/bin/sh\necho found-off-path\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		t.Setenv("HOME", home)
		// Deliberately NOT on PATH: that is the whole condition under test.
		t.Setenv("PATH", "/usr/bin:/bin")

		h := start(t, nil)
		h.welcome(nil)
		waitUntil(t, "the welcome to be adopted", func() bool { return h.agent.HostID() == testHostID })

		command := protocol.NewAgentExec()
		command.CommandID = "00000000-0000-4000-8000-00000000000e"
		command.Command = "pdmux-offpath-probe"
		command.TimeoutMs = 5_000
		h.session.send(&protocol.ExecFrame{Exec: command})

		waitUntil(t, "the result to come back", func() bool { return len(framesOf[*protocol.ExecResultFrame](h)) == 1 })
		got := framesOf[*protocol.ExecResultFrame](h)[0].Result
		if got.Code != nil {
			t.Fatalf("code = %v, want nil: the binary is there, just not on PATH", *got.Code)
		}
		if !strings.Contains(got.Stdout, "found-off-path") {
			t.Fatalf("stdout = %q, want the off-PATH binary's output", got.Stdout)
		}
	})

	t.Run("[TC-PDMCP-003] announces the capability, so the server never sends into silence", func(t *testing.T) {
		h := start(t, nil)
		h.welcome(nil)
		waitUntil(t, "the hello to arrive", func() bool { return len(framesOf[*protocol.HelloFrame](h)) == 1 })
		hello := framesOf[*protocol.HelloFrame](h)[0].Hello
		if !slices.Contains(hello.Capabilities, protocol.CapabilityExec) {
			t.Fatalf("capabilities = %v, want exec among them", hello.Capabilities)
		}
	})
}
