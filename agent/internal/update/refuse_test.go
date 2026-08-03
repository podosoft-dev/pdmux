package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// The refusals. Each one is a class of fleet-wide outage compressed into one
// reported frame, so each one is checked by making the outage happen.

func TestRefusals(t *testing.T) {
	t.Run("[TC-PDAGENT-074] refuses a version that is not newer, unless it is forced", func(t *testing.T) {
		for _, version := range []string{"0.1.0", "0.0.9"} {
			h := newHarness(t)
			h.run(func(update *protocol.AgentUpdate) { update.Version = version })
			final := h.final()
			if final.Phase != protocol.PhaseFailed || final.Code == nil || *final.Code != CodeNotNewer {
				t.Fatalf("%s: final = %+v, want failed/%s", version, final, CodeNotNewer)
			}
			if len(h.requests()) != 0 {
				t.Fatalf("%s: a refused update must not download anything", version)
			}
		}

		// A deliberate downgrade is a real operation — the new build is bad and the
		// fleet has to go back. `force` skips the comparison and NOTHING else.
		forced := newHarness(t)
		forced.run(func(update *protocol.AgentUpdate) {
			update.Version = "0.0.9"
			update.Force = true
		})
		if forced.final().Phase != protocol.PhaseRestarting {
			t.Fatalf("a forced downgrade was refused: %+v", forced.final())
		}
		if forced.verifyRan != 1 {
			t.Fatal("a forced downgrade must still pass Gate 1")
		}
	})

	t.Run("[TC-PDAGENT-074] allows an update when the versions cannot be compared", func(t *testing.T) {
		// A hand-edited or unusual version string must not make a host permanently
		// un-updatable: the comparison exists to catch a stale row, and a version we
		// cannot parse is not evidence of one. Gate 1 still has to pass.
		h := newHarness(t)
		request := h.request(func(update *protocol.AgentUpdate) { update.Version = "2026.07.26-nightly" })
		request.CurrentVersion = "not-a-version"
		h.engine.HandleUpdate(context.Background(), request)
		if h.final().Phase != protocol.PhaseRestarting {
			t.Fatalf("final = %+v, want the update to proceed", h.final())
		}
	})

	t.Run("[TC-PDAGENT-074] refuses a build for another machine before it runs it", func(t *testing.T) {
		for _, mutate := range []func(*protocol.AgentUpdate){
			func(u *protocol.AgentUpdate) { u.OS = "darwin" },
			func(u *protocol.AgentUpdate) { u.Arch = "arm64" },
		} {
			h := newHarness(t)
			h.run(mutate)
			final := h.final()
			if final.Phase != protocol.PhaseFailed || final.Code == nil || *final.Code != CodeArchMismatch {
				t.Fatalf("final = %+v, want failed/%s", final, CodeArchMismatch)
			}
			if len(h.requests()) != 0 {
				t.Fatal("a build for another machine must not be downloaded")
			}
		}
	})

	t.Run("[TC-PDAGENT-074] refuses an artifact path that is not a path on our own origin", func(t *testing.T) {
		// ⚠ This is the SSRF boundary. Every entry here, accepted, would turn one
		// frame into "every host in the fleet fetches arbitrary bytes from an
		// arbitrary origin".
		for _, path := range []string{
			"https://evil.example/payload",
			"//evil.example/payload",
			"releases/pdmux-agent",
			"/releases/../../etc/shadow",
			"/releases/pdmux?x=1",
			"/releases/pdmux#x",
			"/releases/pdmux agent",
			"",
		} {
			h := newHarness(t)
			h.run(func(update *protocol.AgentUpdate) { update.ArtifactPath = path })
			final := h.final()
			if final.Phase != protocol.PhaseFailed || final.Code == nil || *final.Code != CodeBadArtifactPath {
				t.Fatalf("%q: final = %+v, want failed/%s", path, final, CodeBadArtifactPath)
			}
			if len(h.requests()) != 0 {
				t.Fatalf("%q: nothing may be fetched for a refused path", path)
			}
		}

		// And the shape that IS accepted still resolves against our own origin.
		url, err := ArtifactURL("wss://pdmux.example/agent/ws", "/releases/pdmux-agent-0.2.0")
		if err != nil {
			t.Fatal(err)
		}
		if url != "https://pdmux.example/releases/pdmux-agent-0.2.0" {
			t.Fatalf("artifact url = %q", url)
		}
	})

	t.Run("[TC-PDAGENT-074] refuses a redirect off our own origin and follows one that stays", func(t *testing.T) {
		elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(newBinary))
		}))
		defer elsewhere.Close()

		away := newHarness(t)
		away.routes["/releases/pdmux-agent"] = func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, elsewhere.URL+"/payload", http.StatusFound)
		}
		away.run()
		final := away.final()
		if final.Phase != protocol.PhaseFailed || final.Code == nil || *final.Code != CodeRedirectRefused {
			t.Fatalf("final = %+v, want failed/%s", final, CodeRedirectRefused)
		}
		if got := readFile(t, away.exe); got != oldBinary {
			t.Fatal("nothing may be installed from a refused redirect")
		}

		// A reverse proxy that adds a path segment is ordinary; same origin, so it
		// is followed.
		nearby := newHarness(t)
		nearby.routes["/releases/moved"] = func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "/releases/pdmux-agent", http.StatusFound)
		}
		nearby.run(func(update *protocol.AgentUpdate) { update.ArtifactPath = "/releases/moved" })
		if nearby.final().Phase != protocol.PhaseRestarting {
			t.Fatalf("a same-origin redirect was refused: %+v", nearby.final())
		}
	})

	t.Run("[TC-PDAGENT-074] refuses bytes that disagree with the frame", func(t *testing.T) {
		short := newHarness(t)
		short.run(func(update *protocol.AgentUpdate) { update.Bytes = int64(len(newBinary)) + 10 })
		if final := short.final(); final.Code == nil || *final.Code != CodeSizeMismatch {
			t.Fatalf("a short body: final = %+v, want %s", final, CodeSizeMismatch)
		}

		// Longer than promised, hashing to the promised digest is impossible — but
		// the size check has to fire on its own, or a truncated read would silently
		// install a prefix of a different artifact.
		long := newHarness(t)
		long.artifact = []byte(newBinary + "trailing bytes")
		sum := sha256.Sum256([]byte(newBinary))
		long.run(func(update *protocol.AgentUpdate) {
			update.Bytes = int64(len(newBinary))
			update.SHA256 = hex.EncodeToString(sum[:])
		})
		if final := long.final(); final.Code == nil || *final.Code != CodeSizeMismatch {
			t.Fatalf("a long body: final = %+v, want %s", final, CodeSizeMismatch)
		}
		if got := readFile(t, long.exe); got != oldBinary {
			t.Fatal("nothing may be installed from a body of the wrong size")
		}

		wrong := newHarness(t)
		wrong.run(func(update *protocol.AgentUpdate) { update.SHA256 = strings.Repeat("b", 64) })
		if final := wrong.final(); final.Code == nil || *final.Code != CodeShaMismatch {
			t.Fatalf("a wrong hash: final = %+v, want %s", final, CodeShaMismatch)
		}
	})

	t.Run("[TC-PDAGENT-074] refuses to exit when nothing would start it again", func(t *testing.T) {
		h := newHarness(t, func(o *Options) {
			o.Ability = func() protocol.AgentUpdateAbility { return protocol.NewAgentUpdateAbility() }
		})
		h.run()
		final := h.final()
		if final.Phase != protocol.PhaseFailed || final.Code == nil || *final.Code != CodeNoRestartSource {
			t.Fatalf("final = %+v, want failed/%s", final, CodeNoRestartSource)
		}
		if len(h.exits) != 0 {
			t.Fatal("an agent with no supervisor must never exit for an update")
		}
	})

	t.Run("[TC-PDAGENT-074] refuses at accept time when it cannot replace its own binary", func(t *testing.T) {
		gone := newHarness(t, func(o *Options) {
			o.ExePath = filepath.Join(t.TempDir(), "no-such-dir", "pdmux-agent")
		})
		gone.run()
		final := gone.final()
		if final.Phase != protocol.PhaseFailed || final.Code == nil || *final.Code != CodeExeNotWritable {
			t.Fatalf("final = %+v, want failed/%s", final, CodeExeNotWritable)
		}
		if len(gone.requests()) != 0 {
			t.Fatal("the check must come BEFORE the download, not at the last rename")
		}

		if os.Geteuid() == 0 {
			t.Skip("root ignores the permission bits; the check above covers the rest")
		}
		locked := newHarness(t)
		if err := os.Chmod(locked.binDir, 0o500); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(locked.binDir, 0o700) })
		locked.run()
		if final := locked.final(); final.Code == nil || *final.Code != CodeExeNotWritable {
			t.Fatalf("read-only directory: final = %+v, want %s", final, CodeExeNotWritable)
		}
	})
}

func TestBusyAndIdempotency(t *testing.T) {
	t.Run("[TC-PDAGENT-074] a different command is BUSY while one is in flight, the same one replays", func(t *testing.T) {
		release := make(chan struct{})
		entered := make(chan struct{})
		h := newHarness(t, func(o *Options) {
			o.Verify = func(context.Context, string, VerifySpec) error {
				close(entered)
				<-release
				return nil
			}
		})
		// The engine's own Report is not goroutine-safe in this harness, so the
		// in-flight update reports into its own slice.
		var inflight []protocol.UpdateStatus
		request := h.request()
		request.Report = func(status protocol.UpdateStatus) { inflight = append(inflight, status) }
		done := make(chan struct{})
		go func() {
			h.engine.HandleUpdate(context.Background(), request)
			close(done)
		}()
		<-entered

		// A DIFFERENT command while one is running: refused, loudly.
		other := h.request(func(update *protocol.AgentUpdate) {
			update.CommandID = "11111111-2222-3333-4444-555555555555"
		})
		h.engine.HandleUpdate(context.Background(), other)
		if final := h.final(); final.Phase != protocol.PhaseFailed || final.Code == nil || *final.Code != CodeBusy {
			t.Fatalf("final = %+v, want failed/%s", final, CodeBusy)
		}

		// The SAME command: the current phase again, and no second download. This
		// is what makes the server's retry safe.
		before := len(h.requests())
		h.statuses = nil
		h.engine.HandleUpdate(context.Background(), h.request())
		if len(h.statuses) != 1 || h.statuses[0].Phase != protocol.PhaseVerifying {
			t.Fatalf("replay = %+v, want the current phase (verifying)", h.statuses)
		}
		if after := len(h.requests()); after != before {
			t.Fatalf("a repeated commandId downloaded again (%d -> %d)", before, after)
		}

		close(release)
		<-done
	})

	t.Run("[TC-PDAGENT-074] a repeat after the outcome replays the outcome", func(t *testing.T) {
		h := newHarness(t)
		h.verifyErr = errors.New("closed before welcome")
		h.run()
		first := h.final()
		before := len(h.requests())

		h.statuses = nil
		h.run()
		if len(h.statuses) != 1 {
			t.Fatalf("a repeat produced %d statuses, want 1", len(h.statuses))
		}
		replay := h.statuses[0]
		if replay.Phase != first.Phase || replay.Code == nil || *replay.Code != *first.Code {
			t.Fatalf("replay = %+v, want the recorded outcome %+v", replay, first)
		}
		if after := len(h.requests()); after != before {
			t.Fatalf("a repeated commandId downloaded again (%d -> %d)", before, after)
		}
	})

	t.Run("[TC-PDAGENT-074] the O_EXCL lock refuses a second PROCESS, and is stolen when stale", func(t *testing.T) {
		h := newHarness(t)
		dir := h.engine.Dir()

		// A live holder — this very test process, which is certainly alive.
		release, holder, err := acquireLock(dir, "other-command", os.Getpid(), h.now)
		if err != nil || release == nil {
			t.Fatalf("first acquire failed: %v (holder %q)", err, holder)
		}
		if _, holder, err = acquireLock(dir, testCommand, os.Getpid(), h.now); err == nil {
			t.Fatal("a second acquire must fail while the lock is held")
		} else if holder != "other-command" {
			t.Fatalf("holder = %q, want the other command's id", holder)
		}
		// The engine reports that as BUSY: the mutex knows nothing about another
		// process, which is exactly why this second half exists.
		h.run()
		if final := h.final(); final.Phase != protocol.PhaseFailed || final.Code == nil || *final.Code != CodeBusy {
			t.Fatalf("final = %+v, want failed/%s", final, CodeBusy)
		}
		release()

		// A STALE holder: an update ends in exit(0), and a kill -9 ends it without
		// removing anything. Refusing forever would need a human with a shell.
		dead := reapedPID(t)
		if err := os.WriteFile(filepath.Join(dir, lockFile),
			[]byte(`{"commandId":"ghost","pid":`+itoa(dead)+`}`), 0o600); err != nil {
			t.Fatal(err)
		}
		release, holder, err = acquireLock(dir, testCommand, os.Getpid(), h.now)
		if err != nil {
			t.Fatalf("a stale lock must be stolen, got %v (holder %q)", err, holder)
		}
		release()
		if _, err := os.Stat(filepath.Join(dir, lockFile)); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("releasing the lock must remove the file")
		}
	})
}

func TestRateLimit(t *testing.T) {
	t.Run("[TC-PDAGENT-074] allows three attempts per window, per target version", func(t *testing.T) {
		dir := t.TempDir()
		now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)

		for attempt := 1; attempt <= 3; attempt++ {
			if err := checkRate(dir, "0.2.0", now, DefaultMaxAttempts, DefaultRateWindow); err != nil {
				t.Fatalf("attempt %d refused: %v", attempt, err)
			}
			if err := recordAttempt(dir, "0.2.0", now, DefaultMaxAttempts, DefaultRateWindow); err != nil {
				t.Fatalf("attempt %d not recorded: %v", attempt, err)
			}
			now = now.Add(time.Minute)
		}
		err := checkRate(dir, "0.2.0", now, DefaultMaxAttempts, DefaultRateWindow)
		if code, _ := explain(err); code != CodeRateLimited {
			t.Fatalf("the fourth attempt was allowed (code %q)", code)
		}

		// A FIXED build must not inherit the broken one's budget — that is why the
		// limiter counts per target version.
		if err := checkRate(dir, "0.2.1", now, DefaultMaxAttempts, DefaultRateWindow); err != nil {
			t.Fatalf("another version was refused: %v", err)
		}
		// And the window rolls.
		if err := checkRate(dir, "0.2.0", now.Add(DefaultRateWindow), DefaultMaxAttempts, DefaultRateWindow); err != nil {
			t.Fatalf("after the window: %v", err)
		}
	})

	t.Run("[TC-PDAGENT-074] survives the agent restarting, and refuses before downloading", func(t *testing.T) {
		h := newHarness(t)
		// Three attempts already on record in the state directory — which is the
		// point: the loop being bounded includes the agent restarting, so an
		// in-memory counter would reset exactly when it matters.
		for offset := range 3 {
			if err := recordAttempt(h.engine.Dir(), "0.2.0", h.now.Add(time.Duration(offset)*time.Minute),
				DefaultMaxAttempts, DefaultRateWindow); err != nil {
				t.Fatal(err)
			}
		}
		h.now = h.now.Add(5 * time.Minute)
		h.run()

		final := h.final()
		if final.Phase != protocol.PhaseFailed || final.Code == nil || *final.Code != CodeRateLimited {
			t.Fatalf("final = %+v, want failed/%s", final, CodeRateLimited)
		}
		if len(h.requests()) != 0 {
			t.Fatal("a rate-limited update must not download anything")
		}
	})

	t.Run("[TC-PDAGENT-074] a refused update does not spend an attempt", func(t *testing.T) {
		h := newHarness(t)
		// A server that sends a build for the wrong architecture three times must
		// not exhaust the budget for the CORRECTED frame that follows. Each one
		// carries its own commandId, as a real server's would.
		for attempt := range 3 {
			h.run(func(update *protocol.AgentUpdate) {
				update.CommandID = "0000000" + itoa(attempt) + "-1111-2222-3333-444444444444"
				update.Arch = "arm64"
			})
		}
		if err := checkRate(h.engine.Dir(), "0.2.0", h.now, DefaultMaxAttempts, DefaultRateWindow); err != nil {
			t.Fatalf("refusals were counted as attempts: %v", err)
		}
	})
}

func TestServiceManagerProbe(t *testing.T) {
	t.Run("[TC-PDAGENT-074] explicit beats inferred, and the default is no", func(t *testing.T) {
		cases := []struct {
			name string
			env  map[string]string
			goos string
			ppid int
			want protocol.AgentUpdateAbility
		}{
			{
				name: "the installer's marker, on linux",
				env:  map[string]string{EnvRestart: RestartService},
				goos: "linux",
				want: protocol.AgentUpdateAbility{CanRestart: true, RestartMode: protocol.RestartSystemd},
			},
			{
				name: "the installer's marker, on darwin",
				env:  map[string]string{EnvRestart: RestartService},
				goos: "darwin",
				want: protocol.AgentUpdateAbility{CanRestart: true, RestartMode: protocol.RestartLaunchd},
			},
			{
				// An operator (or a container entrypoint) saying "not here" must win
				// over an inference that would otherwise say yes.
				name: "an explicit no beats systemd's own variables",
				env:  map[string]string{EnvRestart: RestartNone, "INVOCATION_ID": "abc"},
				goos: "linux",
				want: protocol.AgentUpdateAbility{CanRestart: false, RestartMode: protocol.RestartNone},
			},
			{
				name: "inferred from systemd",
				env:  map[string]string{"INVOCATION_ID": "abc"},
				goos: "linux",
				want: protocol.AgentUpdateAbility{CanRestart: true, RestartMode: protocol.RestartSystemd},
			},
			{
				name: "inferred from a readiness socket",
				env:  map[string]string{"NOTIFY_SOCKET": "/run/systemd/notify"},
				goos: "linux",
				want: protocol.AgentUpdateAbility{CanRestart: true, RestartMode: protocol.RestartSystemd},
			},
			{
				name: "inferred from launchd",
				env:  map[string]string{},
				goos: "darwin",
				ppid: 1,
				want: protocol.AgentUpdateAbility{CanRestart: true, RestartMode: protocol.RestartLaunchd},
			},
			{
				// Run from a terminal: exiting would end this host's participation in
				// the fleet, so the dashboard must not offer the button.
				name: "a bare process on linux",
				env:  map[string]string{},
				goos: "linux",
				ppid: 4242,
				want: protocol.AgentUpdateAbility{CanRestart: false, RestartMode: protocol.RestartNone},
			},
			{
				name: "a bare process on darwin",
				env:  map[string]string{},
				goos: "darwin",
				ppid: 4242,
				want: protocol.AgentUpdateAbility{CanRestart: false, RestartMode: protocol.RestartNone},
			},
		}
		for _, one := range cases {
			got := Ability(one.env, one.goos, one.ppid)
			if got != one.want {
				t.Fatalf("%s: ability = %+v, want %+v", one.name, got, one.want)
			}
		}
	})
}

// reapedPID returns the pid of a process that has certainly exited.
func reapedPID(t *testing.T) int {
	t.Helper()
	command := exec.Command("/bin/sh", "-c", "exit 0")
	if err := command.Run(); err != nil {
		t.Fatal(err)
	}
	return command.ProcessState.Pid()
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits []byte
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}
