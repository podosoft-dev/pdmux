package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/agent"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// Everything in this package is filesystem and process state, so the specs use a
// real temp directory, real files, a real HTTP server and — where the point is
// that something is EXECUTED — real (tiny) shell scripts. A mock filesystem
// would agree with whatever the implementation does, which is the one thing
// these tests must not do.

const (
	oldBinary   = "#!/bin/sh\necho old\n"
	newBinary   = "#!/bin/sh\necho new\n"
	testCommand = "6f1a4c2e-8b3d-4a5f-9c7e-1d2b3a4c5d6e"
)

type harness struct {
	t        *testing.T
	stateDir string
	binDir   string
	exe      string
	engine   *Engine
	server   *httptest.Server
	artifact []byte

	now time.Time

	statuses []protocol.UpdateStatus
	exits    []int

	// routes overrides the artifact handler for one path (redirect specs).
	routes map[string]http.HandlerFunc
	// mu guards what the SERVER goroutine writes; the test reads it afterwards.
	mu sync.Mutex

	// verifySaw records what was installed at THE MOMENT Gate 1 ran. It is the
	// assertion that matters most in this file: the candidate must be interviewed
	// while the old binary is still the one in place.
	verifySaw      string
	verifyMode     os.FileMode
	verifySpec     VerifySpec
	verifyRan      int
	verifyErr      error
	requestedPaths []string
	sentKey        string
}

func newHarness(t *testing.T, options ...func(*Options)) *harness {
	t.Helper()
	h := &harness{
		t:        t,
		stateDir: t.TempDir(),
		binDir:   t.TempDir(),
		artifact: []byte(newBinary),
		now:      time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC),
		routes:   map[string]http.HandlerFunc{},
	}
	h.exe = filepath.Join(h.binDir, "pdmux-agent")
	writeExecutable(t, h.exe, oldBinary)

	h.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		h.requestedPaths = append(h.requestedPaths, r.URL.Path)
		h.sentKey = r.Header.Get(protocol.AgentKeyHeader)
		route, overridden := h.routes[r.URL.Path]
		h.mu.Unlock()
		if overridden {
			route(w, r)
			return
		}
		if r.URL.Path != "/releases/pdmux-agent" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write(h.artifact)
	}))
	t.Cleanup(h.server.Close)

	opts := Options{
		ExePath:   h.exe,
		StateDir:  h.stateDir,
		ServerURL: wsURL(h.server.URL),
		Token:     "agent-key",
		Version:   "0.1.0",
		Settle:    0,
		// Pinned rather than inherited: the artifact in these specs claims
		// linux/amd64, and a spec that passes only on the machine it was written on
		// is not testing the architecture check.
		GOOS:   "linux",
		GOARCH: "amd64",
		Now:    func() time.Time { return h.now },
		Exit:   func(code int) { h.exits = append(h.exits, code) },
		Ability: func() protocol.AgentUpdateAbility {
			return protocol.AgentUpdateAbility{CanRestart: true, RestartMode: protocol.RestartSystemd}
		},
		Verify: func(_ context.Context, candidate string, spec VerifySpec) error {
			h.verifyRan++
			h.verifySpec = spec
			h.verifySaw = readFile(t, h.exe)
			if info, err := os.Stat(candidate); err == nil {
				h.verifyMode = info.Mode().Perm()
			}
			return h.verifyErr
		},
	}
	for _, apply := range options {
		apply(&opts)
	}
	h.engine = New(opts)
	return h
}

// request builds the frame and the Report the agent would hand the engine.
func (h *harness) request(mutate ...func(*protocol.AgentUpdate)) agent.UpdateRequest {
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
	return agent.UpdateRequest{
		Update:         update,
		CurrentVersion: "0.1.0",
		Report:         func(status protocol.UpdateStatus) { h.statuses = append(h.statuses, status) },
	}
}

func (h *harness) run(mutate ...func(*protocol.AgentUpdate)) {
	h.t.Helper()
	h.engine.HandleUpdate(context.Background(), h.request(mutate...))
}

func (h *harness) key() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.sentKey
}

func (h *harness) requests() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.requestedPaths...)
}

func (h *harness) phases() []protocol.UpdatePhase {
	var out []protocol.UpdatePhase
	for _, status := range h.statuses {
		out = append(out, status.Phase)
	}
	return out
}

func (h *harness) final() protocol.UpdateStatus {
	h.t.Helper()
	if len(h.statuses) == 0 {
		h.t.Fatal("no status was reported")
	}
	return h.statuses[len(h.statuses)-1]
}

func TestUpdateEngine(t *testing.T) {
	t.Run("[TC-PDAGENT-073] verifies the candidate while the old binary is still installed", func(t *testing.T) {
		h := newHarness(t)
		h.run()

		if h.verifyRan != 1 {
			t.Fatalf("Gate 1 ran %d times, want exactly 1", h.verifyRan)
		}
		// THE assertion of this package. If this ever reads "new", the swap has
		// moved ahead of the check and the whole design is gone.
		if h.verifySaw != oldBinary {
			t.Fatalf("at verify time the installed binary was %q, want the OLD one", h.verifySaw)
		}
		if h.verifyMode != executableMode {
			t.Fatalf("the candidate was %v at verify time, want %v", h.verifyMode, executableMode)
		}
		if got := readFile(t, h.exe); got != newBinary {
			t.Fatalf("installed binary is %q, want the new one", got)
		}
		if got := readFile(t, h.exe+".bak"); got != oldBinary {
			t.Fatalf("backup is %q, want the old binary", got)
		}
		if _, err := os.Stat(h.exe + ".new"); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("the staged file must be gone after the rename")
		}
		if key := h.key(); key != "agent-key" {
			t.Fatalf("the artifact request carried key %q", key)
		}
		// The candidate is told to use the non-registering mode, which is what
		// stops the verify dial from evicting the live socket.
		if !strings.Contains(h.verifySpec.URL, VerifyModeParam+"="+VerifyMode) {
			t.Fatalf("verify URL %q does not select the non-registering mode", h.verifySpec.URL)
		}
		if h.verifySpec.Token != "agent-key" {
			t.Fatalf("verify spec token = %q", h.verifySpec.Token)
		}

		want := []protocol.UpdatePhase{
			protocol.PhaseAccepted,
			protocol.PhaseDownloading,
			protocol.PhaseVerifying,
			protocol.PhaseSwapping,
			protocol.PhaseRestarting,
		}
		got := h.phases()
		// Progress frames repeat `downloading`; compare the distinct sequence.
		if distinct := dedupe(got); !equalPhases(distinct, want) {
			t.Fatalf("phases = %v, want %v", distinct, want)
		}
		if len(h.exits) != 1 || h.exits[0] != 0 {
			t.Fatalf("exits = %v, want exactly [0] — the service manager starts the new binary", h.exits)
		}
	})

	t.Run("[TC-PDAGENT-073] arms the probation marker before the swap is committed", func(t *testing.T) {
		h := newHarness(t)
		h.run()

		pending, ok, err := readPending(h.engine.Dir())
		if err != nil || !ok {
			t.Fatalf("no probation marker after the swap (err=%v)", err)
		}
		if pending.TargetVersion != "0.2.0" || pending.PreviousVersion != "0.1.0" {
			t.Fatalf("marker = %+v", pending)
		}
		if pending.ExePath != h.exe || pending.BackupPath != h.exe+".bak" {
			t.Fatalf("marker does not name the paths a rollback needs: %+v", pending)
		}
		if want := h.now.Add(300 * time.Second).Unix(); pending.DeadlineUnix != want {
			t.Fatalf("deadline = %d, want %d (probationSec from the frame)", pending.DeadlineUnix, want)
		}
		if pending.Attempts != 0 {
			t.Fatalf("attempts = %d, want 0 — the new binary has not started yet", pending.Attempts)
		}
		info, err := os.Stat(filepath.Join(h.engine.Dir(), pendingFile))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("marker mode = %v, want 0600", info.Mode().Perm())
		}
	})

	t.Run("[TC-PDAGENT-073] commits at welcome, not at process start", func(t *testing.T) {
		h := newHarness(t)
		h.run()

		// The NEW binary starts: same state dir, its own version.
		fresh := newRestarted(t, h, "0.2.0")
		outcome := fresh.Startup()
		if outcome.Action != StartupProbation {
			t.Fatalf("startup action = %q, want probation", outcome.Action)
		}
		if _, ok, _ := readPending(fresh.Dir()); !ok {
			t.Fatal("the marker must survive process start — starting proves nothing")
		}

		var reported []protocol.UpdateStatus
		fresh.Connected(func(status protocol.UpdateStatus) { reported = append(reported, status) })
		if _, ok, _ := readPending(fresh.Dir()); ok {
			t.Fatal("the marker must be cleared by a completed handshake")
		}
		if len(reported) != 1 || reported[0].Phase != protocol.PhaseDone {
			t.Fatalf("reported = %+v, want one `done`", reported)
		}
		if reported[0].CommandID != testCommand {
			t.Fatalf("`done` carries commandId %q, want the original", reported[0].CommandID)
		}
		if reported[0].CurrentVersion != "0.2.0" {
			t.Fatalf("`done` reports currentVersion %q, want the version now running", reported[0].CurrentVersion)
		}
	})

	t.Run("[TC-PDAGENT-073] rolls back when probation's deadline passes", func(t *testing.T) {
		h := newHarness(t)
		h.run()

		fresh := newRestarted(t, h, "0.2.0")
		fresh.opt.Now = func() time.Time { return h.now.Add(301 * time.Second) }
		outcome := fresh.Startup()

		if outcome.Action != StartupRolledBack || !outcome.Exit {
			t.Fatalf("outcome = %+v, want a rollback that exits", outcome)
		}
		if got := readFile(t, h.exe); got != oldBinary {
			t.Fatalf("installed binary is %q, want the restored old one", got)
		}
		if _, ok, _ := readPending(fresh.Dir()); ok {
			t.Fatal("a rollback must clear the marker, or the next start rolls back again")
		}

		// The restored binary reports the rollback on ITS next connect — that is
		// what keeps the outcome from being a silence.
		restored := newRestarted(t, h, "0.1.0")
		var reported []protocol.UpdateStatus
		restored.Connected(func(status protocol.UpdateStatus) { reported = append(reported, status) })
		if len(reported) != 1 {
			t.Fatalf("reported %d statuses, want 1", len(reported))
		}
		status := reported[0]
		if status.Phase != protocol.PhaseRolledBack {
			t.Fatalf("phase = %q, want rolledBack", status.Phase)
		}
		if status.Code == nil || *status.Code != CodeProbationExpired {
			t.Fatalf("code = %v, want %s", status.Code, CodeProbationExpired)
		}
		if status.CurrentVersion != "0.1.0" || status.TargetVersion == nil || *status.TargetVersion != "0.2.0" {
			t.Fatalf("versions = %q -> %v", status.CurrentVersion, status.TargetVersion)
		}
		// Reported once, not on every reconnect.
		reported = nil
		restored.Connected(func(status protocol.UpdateStatus) { reported = append(reported, status) })
		if len(reported) != 0 {
			t.Fatalf("the breadcrumb was reported again: %+v", reported)
		}
	})

	t.Run("[TC-PDAGENT-073] rolls back when the attempts run out", func(t *testing.T) {
		h := newHarness(t)
		h.run()

		fresh := newRestarted(t, h, "0.2.0")
		// Three starts inside the deadline: still on trial, and each one is counted
		// BEFORE any network, so a crash loop cannot outrun the counter.
		for attempt := 1; attempt <= 3; attempt++ {
			outcome := fresh.Startup()
			if outcome.Action != StartupProbation {
				t.Fatalf("start %d: action = %q, want probation", attempt, outcome.Action)
			}
			if outcome.Attempts != attempt {
				t.Fatalf("start %d: attempts = %d", attempt, outcome.Attempts)
			}
			pending, _, _ := readPending(fresh.Dir())
			if pending.Attempts != attempt {
				t.Fatalf("start %d: on disk attempts = %d", attempt, pending.Attempts)
			}
		}
		outcome := fresh.Startup()
		if outcome.Action != StartupRolledBack || !outcome.Exit {
			t.Fatalf("fourth start: outcome = %+v, want a rollback", outcome)
		}
		if got := readFile(t, h.exe); got != oldBinary {
			t.Fatalf("installed binary is %q, want the restored old one", got)
		}
		restored := newRestarted(t, h, "0.1.0")
		var reported []protocol.UpdateStatus
		restored.Connected(func(status protocol.UpdateStatus) { reported = append(reported, status) })
		if len(reported) != 1 || reported[0].Code == nil || *reported[0].Code != CodeProbationAttempts {
			t.Fatalf("reported = %+v, want %s", reported, CodeProbationAttempts)
		}
	})

	t.Run("[TC-PDAGENT-073] clears a marker that names a version this binary is not", func(t *testing.T) {
		h := newHarness(t)
		h.run()

		// The benign window: the marker was armed, the rename never happened, and
		// the OLD binary is the one that started.
		writeExecutable(t, h.exe, oldBinary)
		stale := newRestarted(t, h, "0.1.0")
		outcome := stale.Startup()
		if outcome.Action != StartupNormal {
			t.Fatalf("action = %q, want a normal start", outcome.Action)
		}
		if _, ok, _ := readPending(stale.Dir()); ok {
			t.Fatal("a marker for another version must be cleared, not carried")
		}
		var reported []protocol.UpdateStatus
		stale.Connected(func(status protocol.UpdateStatus) { reported = append(reported, status) })
		if len(reported) != 1 || reported[0].Code == nil || *reported[0].Code != CodeSwapIncomplete {
			t.Fatalf("reported = %+v, want %s", reported, CodeSwapIncomplete)
		}
	})

	t.Run("[TC-PDAGENT-073] a failed download leaves the installed binary untouched", func(t *testing.T) {
		h := newHarness(t)
		// The bytes the server serves are not the bytes the frame promised.
		h.artifact = []byte(newBinary)
		request := h.request(func(update *protocol.AgentUpdate) {
			update.SHA256 = strings.Repeat("a", 64)
		})
		h.engine.HandleUpdate(context.Background(), request)

		final := h.final()
		if final.Phase != protocol.PhaseFailed || final.Code == nil || *final.Code != CodeShaMismatch {
			t.Fatalf("final = %+v, want failed/%s", final, CodeShaMismatch)
		}
		if got := readFile(t, h.exe); got != oldBinary {
			t.Fatalf("installed binary is %q — a failed download must not touch it", got)
		}
		for _, stray := range []string{h.exe + ".new", h.exe + ".bak"} {
			if _, err := os.Stat(stray); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("%s exists after a failed download", stray)
			}
		}
		if _, ok, _ := readPending(h.engine.Dir()); ok {
			t.Fatal("no marker may be armed when nothing was installed")
		}
		if h.verifyRan != 0 {
			t.Fatal("Gate 1 must not run on bytes that failed their hash")
		}
		if len(h.exits) != 0 {
			t.Fatalf("exits = %v, want none", h.exits)
		}
	})

	t.Run("[TC-PDAGENT-073] a candidate that cannot connect is never installed", func(t *testing.T) {
		h := newHarness(t)
		h.verifyErr = errors.New("closed before welcome (code 4401 invalid agent key)")
		h.run()

		final := h.final()
		if final.Phase != protocol.PhaseFailed || final.Code == nil || *final.Code != CodeVerifyFailed {
			t.Fatalf("final = %+v, want failed/%s", final, CodeVerifyFailed)
		}
		if !strings.Contains(final.Message, "4401") {
			t.Fatalf("message %q drops the candidate's own explanation", final.Message)
		}
		if got := readFile(t, h.exe); got != oldBinary {
			t.Fatalf("installed binary is %q — Gate 1 said no", got)
		}
		if _, err := os.Stat(h.exe + ".new"); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("the rejected candidate must be removed")
		}
		if _, ok, _ := readPending(h.engine.Dir()); ok {
			t.Fatal("no marker may be armed when nothing was installed")
		}
		if len(h.exits) != 0 {
			t.Fatalf("exits = %v, want none — the agent keeps running", h.exits)
		}
	})

	t.Run("[TC-PDAGENT-073] reports attached terminals with `accepted` instead of refusing", func(t *testing.T) {
		h := newHarness(t, func(o *Options) {
			o.Panes = func() (int, int) { return 2, 3 }
		})
		h.run()
		if h.final().Phase != protocol.PhaseRestarting {
			t.Fatalf("attached terminals must not block an update: %+v", h.final())
		}
		var accepted protocol.UpdateStatus
		for _, status := range h.statuses {
			if status.Phase == protocol.PhaseAccepted {
				accepted = status
			}
		}
		if accepted.ShellPanes != 2 || accepted.SessionPanes != 3 {
			t.Fatalf("accepted reported %d/%d panes, want 2/3", accepted.ShellPanes, accepted.SessionPanes)
		}
	})

	t.Run("[TC-PDAGENT-073] runs the real verify subcommand with the config and the token", func(t *testing.T) {
		// No seam here: the default Gate 1 EXECUTES the candidate, and that is the
		// only part of it that proves a downloaded file can run at all.
		dir := t.TempDir()
		record := filepath.Join(dir, "argv")
		candidate := filepath.Join(dir, "candidate")
		writeExecutable(t, candidate, fmt.Sprintf(
			"#!/bin/sh\n{ echo \"$@\"; echo \"token=$PDMUX_TOKEN\"; } > %s\nexit 0\n", record))

		err := execVerify(context.Background(), candidate, VerifySpec{
			URL:        "wss://pdmux.example/agent/ws?mode=verify",
			ConfigPath: "/etc/pdmux/agent.json",
			Token:      "secret-key",
		})
		if err != nil {
			t.Fatalf("verify failed: %v", err)
		}
		got := readFile(t, record)
		for _, want := range []string{"verify", "--server wss://pdmux.example/agent/ws?mode=verify", "--config /etc/pdmux/agent.json", "token=secret-key"} {
			if !strings.Contains(got, want) {
				t.Fatalf("invocation %q is missing %q", got, want)
			}
		}
		// The token must never be an argument: argv is world-readable in `ps`.
		argv := strings.SplitN(got, "\n", 2)[0]
		if strings.Contains(argv, "secret-key") {
			t.Fatalf("the token was passed in argv: %q", argv)
		}

		writeExecutable(t, candidate, "#!/bin/sh\necho 'verify failed: closed before welcome (code 4401)' >&2\nexit 1\n")
		err = execVerify(context.Background(), candidate, VerifySpec{URL: "wss://x/agent/ws"})
		if err == nil || !strings.Contains(err.Error(), "4401") {
			t.Fatalf("a failing candidate must be reported with its own words, got %v", err)
		}
	})
}

func TestSwap(t *testing.T) {
	t.Run("[TC-PDAGENT-073] link+rename keeps the executable path resolvable", func(t *testing.T) {
		dir := t.TempDir()
		exe := filepath.Join(dir, "pdmux-agent")
		staged := exe + ".new"
		backup := exe + ".bak"
		writeExecutable(t, exe, oldBinary)
		writeExecutable(t, staged, newBinary)

		// A poller running across the swap: with link+rename there is no instant in
		// which the name is absent. Two renames would eventually be caught here —
		// and, more importantly, this is the property the comment in swap.go claims.
		stop := make(chan struct{})
		missing := make(chan string, 1)
		go func() {
			for {
				select {
				case <-stop:
					close(missing)
					return
				default:
				}
				if _, err := os.Stat(exe); err != nil {
					select {
					case missing <- err.Error():
					default:
					}
					close(missing)
					return
				}
			}
		}()
		if err := swap(exe, staged, backup); err != nil {
			t.Fatalf("swap: %v", err)
		}
		close(stop)
		if err, caught := <-missing; caught {
			t.Fatalf("the executable path vanished during the swap: %s", err)
		}

		if got := readFile(t, exe); got != newBinary {
			t.Fatalf("installed = %q", got)
		}
		if got := readFile(t, backup); got != oldBinary {
			t.Fatalf("backup = %q", got)
		}
	})

	t.Run("[TC-PDAGENT-073] a swap that fails halfway leaves the old binary in place", func(t *testing.T) {
		dir := t.TempDir()
		exe := filepath.Join(dir, "pdmux-agent")
		backup := exe + ".bak"
		writeExecutable(t, exe, oldBinary)
		// A directory cannot be renamed over a file: the second step fails while the
		// first (the link) has already happened. THIS is the instant that two
		// renames would have left the host with no executable at all.
		if err := os.Mkdir(exe+".new", 0o700); err != nil {
			t.Fatal(err)
		}

		if err := swap(exe, exe+".new", backup); err == nil {
			t.Fatal("swap must fail when the rename cannot happen")
		}
		if got := readFile(t, exe); got != oldBinary {
			t.Fatalf("installed = %q, want the untouched old binary", got)
		}
		if _, err := os.Stat(backup); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("a backup for a swap that did not happen must not be left behind")
		}
	})

	t.Run("[TC-PDAGENT-073] restore puts the previous binary back and keeps the backup", func(t *testing.T) {
		dir := t.TempDir()
		exe := filepath.Join(dir, "pdmux-agent")
		backup := exe + ".bak"
		writeExecutable(t, exe, newBinary)
		writeExecutable(t, backup, oldBinary)

		if err := restore(exe, backup); err != nil {
			t.Fatalf("restore: %v", err)
		}
		if got := readFile(t, exe); got != oldBinary {
			t.Fatalf("installed = %q", got)
		}
		if got := readFile(t, backup); got != oldBinary {
			t.Fatal("the backup must survive a restore, for the human who arrives later")
		}
		if _, err := os.Stat(exe + ".restore"); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("the staging link must be gone")
		}
	})
}

// newRestarted is the same host after the service manager started a binary: the
// same state directory and executable, a different running version.
func newRestarted(t *testing.T, h *harness, version string) *Engine {
	t.Helper()
	return New(Options{
		ExePath:   h.exe,
		StateDir:  h.stateDir,
		ServerURL: wsURL(h.server.URL),
		Version:   version,
		Now:       func() time.Time { return h.now.Add(time.Second) },
		Exit:      func(code int) { h.exits = append(h.exits, code) },
	})
}

func writeExecutable(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func wsURL(httpURL string) string {
	return strings.Replace(httpURL, "http://", "ws://", 1) + protocol.AgentWSPath
}

func dedupe(phases []protocol.UpdatePhase) []protocol.UpdatePhase {
	var out []protocol.UpdatePhase
	for _, phase := range phases {
		if len(out) == 0 || out[len(out)-1] != phase {
			out = append(out, phase)
		}
	}
	return out
}

func equalPhases(a, b []protocol.UpdatePhase) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
