// Package update replaces the agent's own binary on command from the dashboard.
//
// THE ONE FAILURE THAT MATTERS IS A NEW BINARY THAT CANNOT CONNECT. Once a host
// is running a build that cannot dial the server, the server has no way to tell
// it to go back — the button that would fix it lives on the screen the host just
// disappeared from, and someone has to walk to the machine. Everything in this
// package is ordered around making that unreachable, and the ORDER IS THE
// DESIGN: it is not a pipeline that happens to run in this sequence, it is a
// sequence chosen so that the irreversible step is last and is preceded by two
// independent proofs.
//
//	GATE 1 (primary) — VERIFY BEFORE COMMITTING. The running agent execs the
//	candidate as `<candidate> verify --server <its own endpoint>`, which dials,
//	waits for a real `welcome` and exits 0. That single check covers the whole
//	"cannot connect" class — wrong architecture, a missing dynamic loader, TLS
//	roots the new build cannot read, a regressed config parser, a protocol-version
//	gate the server now rejects — and it runs while the OLD binary is still
//	installed and still connected. A failure here costs nothing but a `failed`
//	frame.
//
//	GATE 2 (backstop) — A PROBATION MARKER. Just before the swap is committed the
//	engine writes `pending.json` into the state directory. The NEW binary reads it
//	before it touches the network and clears it only after a successful handshake
//	— `welcome` is the commit point, not process start, because a process that
//	starts and then fails to connect is exactly the case being defended against.
//	Deadline exceeded or too many attempts and it restores `.bak`, records the
//	failure and exits; the service manager starts the restored binary, which
//	reports `rolledBack` on its next connect.
//
//	⚠ BE HONEST ABOUT GATE 2's LIMIT: the marker only protects a host whose
//	CURRENTLY INSTALLED binary already knows what a marker is. The very first
//	update away from a build that predates this package is protected by Gate 1
//	alone. That asymmetry is the reason both gates exist rather than either one.
//
// THE SWAP IS `link` + `rename`, NEVER TWO RENAMES. A hard link does not remove
// its source, so at every instant the executable path resolves to either the old
// inode or the new one. Two renames (exe -> exe.bak, new -> exe) leave a window
// in which the path names nothing at all; a power cut inside that window leaves
// `ExecStart=` pointing at a file that does not exist and the host stays dark
// until a human visits it. Writing in place is not an option to weigh — the
// kernel returns ETXTBSY for a running executable.
//
// RESTART IS `exit(0)`, NOT `systemctl restart`. Both supervisors we support
// relaunch a cleanly exited process (`Restart=always`, `KeepAlive`), so the
// agent needs no privileges and no service-manager client. With NO supervisor,
// exiting is a hole the agent never climbs out of — hence the NO_RESTART_SOURCE
// refusal rather than an attempt.
package update

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/agent"
	"github.com/podosoft-dev/pdmux/agent/internal/config"
	"github.com/podosoft-dev/pdmux/agent/internal/log"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/state"
)

// Reason codes. They are a stable grouping key for the dashboard, so a UI can
// say "3 hosts refused: SHA_MISMATCH" without matching on prose. Adding one is
// additive; renaming one breaks a filter somebody built.
const (
	// CodeNotNewer refuses a version that is not ahead of what is running.
	CodeNotNewer = "NOT_NEWER"
	// CodeShaMismatch and CodeSizeMismatch are the downloaded bytes disagreeing
	// with what the frame promised.
	CodeShaMismatch  = "SHA_MISMATCH"
	CodeSizeMismatch = "SIZE_MISMATCH"
	// CodeArchMismatch turns a guaranteed ENOEXEC brick into one comparison.
	CodeArchMismatch = "ARCH_MISMATCH"
	// CodeBusy is a second, different update while one is in flight.
	CodeBusy = "BUSY"
	// CodeExeNotWritable is checked at accept time, not at the last rename.
	CodeExeNotWritable = "EXE_NOT_WRITABLE"
	// CodeNoRestartSource is "nothing would start me again" — see the package doc.
	CodeNoRestartSource = "NO_RESTART_SOURCE"
	// CodeRateLimited stops a server bug from putting a host in a download loop.
	CodeRateLimited = "RATE_LIMITED"
	// CodeBadArtifactPath is a path that is not a path under our own origin.
	CodeBadArtifactPath = "BAD_ARTIFACT_PATH"
	// CodeRedirectRefused is the download being pointed at another origin.
	CodeRedirectRefused = "REDIRECT_REFUSED"
	// CodeDownloadFailed is transport: no answer, a non-200, a truncated body.
	CodeDownloadFailed = "DOWNLOAD_FAILED"
	// CodeVerifyFailed is Gate 1 saying no. The most valuable code in the list.
	CodeVerifyFailed = "VERIFY_FAILED"
	// CodeSwapFailed is a link/rename that did not happen; the old binary stays.
	CodeSwapFailed = "SWAP_FAILED"
	// CodeStateUnwritable is "I cannot write the probation marker", which means
	// Gate 2 would be absent — so the update stops rather than proceeding
	// half-protected.
	CodeStateUnwritable = "STATE_UNWRITABLE"
	// CodeProbationExpired and CodeProbationAttempts are Gate 2 firing.
	CodeProbationExpired  = "PROBATION_EXPIRED"
	CodeProbationAttempts = "PROBATION_ATTEMPTS"
	// CodeSwapIncomplete is a marker found by a binary that is NOT the target —
	// the swap did not take effect (a crash between marker and rename).
	CodeSwapIncomplete = "SWAP_INCOMPLETE"
)

// Defaults. Every one is overridable in Options so a spec can run the whole
// engine in a temp directory in milliseconds.
const (
	// DefaultMaxAttempts caps both the probation retries and the rate limiter.
	DefaultMaxAttempts = 3
	// DefaultRateWindow is the window the rate limiter counts attempts in.
	DefaultRateWindow = 30 * time.Minute
	// DefaultVerifyTimeout bounds Gate 1. It is generous next to the 8s probe
	// inside `verify` because a cold binary on a loaded host has to be paged in
	// first, and a timeout here reads as "the new build is broken".
	DefaultVerifyTimeout = 60 * time.Second
	// DefaultDownloadTimeout bounds the artifact fetch.
	DefaultDownloadTimeout = 10 * time.Minute
	// DefaultProbationSec matches the contract's own default for probationSec.
	DefaultProbationSec = 300
	// DefaultSettle is a pause between the `restarting` frame and exit(0).
	// net.Client.Send writes to the socket synchronously, so this is not what
	// makes the frame arrive — it is slack for the TLS record and the kernel's
	// send buffer, which do not care that we are about to call exit.
	DefaultSettle = 300 * time.Millisecond
)

// Options configure an Engine. Everything with a host effect is injectable, so
// the specs exercise the real code paths against a temp directory.
type Options struct {
	// ExePath is the binary to replace; empty asks the OS. It is deliberately NOT
	// something the server can influence — see protocol.AgentUpdate's note on why
	// there is no install-path field.
	ExePath string
	// StateDir is where the marker, the attempt log and the lock live; empty
	// resolves it the way the rest of the agent does.
	//
	// ⚠ It is NOT where the download is staged: rename(2) cannot cross a
	// filesystem, and /var/lib and /usr/local/bin are routinely different mounts.
	// The candidate is staged beside the executable for that reason.
	StateDir string
	// ServerURL is the normalised wss:// endpoint this agent is connected to. It
	// is the origin the artifact is fetched from and the endpoint the candidate is
	// told to verify against.
	ServerURL string
	// Token authenticates both, and is registered as a logger secret by the caller.
	Token string
	// ConfigPath is the config file the running agent resolved, passed to the
	// candidate so Gate 1 exercises THIS host's real configuration — including a
	// config parser the new build may have regressed.
	ConfigPath string
	// Version is what is running right now. Used by Startup/Connected, which have
	// no request to read it from.
	Version string
	// Logger records what the engine did; nil silences it.
	Logger *log.Logger
	// Panes reports attached terminals for the `accepted` status. nil reports
	// none. It is a WARNING, never a refusal — see refuse.go.
	Panes func() (shell, session int)
	// Env is the process environment; nil reads the real one.
	Env map[string]string
	// Ability answers "would anything start me again"; nil probes the host.
	Ability func() protocol.AgentUpdateAbility

	// GOOS and GOARCH are this build's target; empty uses runtime's.
	GOOS, GOARCH string

	// MaxAttempts, RateWindow, VerifyTimeout, DownloadTimeout and Settle override
	// the Default* above. Zero means the default.
	MaxAttempts     int
	RateWindow      time.Duration
	VerifyTimeout   time.Duration
	DownloadTimeout time.Duration
	Settle          time.Duration

	// Now is the clock; nil is time.Now.
	Now func() time.Time
	// Exit ends the process so the service manager starts the new binary; nil is
	// os.Exit.
	Exit func(code int)
	// Verify runs Gate 1; nil execs the candidate's own `verify` subcommand.
	Verify VerifyFunc
}

// VerifyFunc runs Gate 1 against a staged candidate. It returns nil when the
// candidate completed a real handshake with the server.
type VerifyFunc func(ctx context.Context, candidate string, spec VerifySpec) error

// VerifySpec is what the candidate needs to dial: everything it is told, so a
// spec can assert on the invocation instead of guessing at it.
type VerifySpec struct {
	// URL is the agent's endpoint with the non-registering mode selected. See
	// verify.go for what the server has to do with it.
	URL string
	// ConfigPath is passed as --config when non-empty.
	ConfigPath string
	// Token rides in the environment, never in argv — argv is world-readable in
	// `ps` on most systems.
	Token string
}

// Engine is the UpdateHandler wired into agent.Options.Update.
type Engine struct {
	opt Options
	// dir is StateDir/update: the marker, the attempt log and the lock.
	dir string

	mu sync.Mutex
	// running is the job in flight, with the last phase reported for it. A repeat
	// of ITS commandId re-emits that phase and does no new work — which is what
	// makes the server's retry safe.
	running *job
	// last is the most recently FINISHED job, kept for the same reason: a retry
	// arriving after the outcome must see the outcome, not start a second attempt.
	last *job
}

type job struct {
	commandID string
	status    protocol.UpdateStatus
}

// New builds an Engine. It does no I/O: a host whose state directory is
// unwritable must still start, report, and say so when an update is attempted.
func New(options Options) *Engine {
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.Exit == nil {
		options.Exit = os.Exit
	}
	if options.Logger == nil {
		options.Logger = log.Silent()
	}
	if options.GOOS == "" {
		options.GOOS = runtime.GOOS
	}
	if options.GOARCH == "" {
		options.GOARCH = runtime.GOARCH
	}
	if options.MaxAttempts <= 0 {
		options.MaxAttempts = DefaultMaxAttempts
	}
	if options.RateWindow <= 0 {
		options.RateWindow = DefaultRateWindow
	}
	if options.VerifyTimeout <= 0 {
		options.VerifyTimeout = DefaultVerifyTimeout
	}
	if options.DownloadTimeout <= 0 {
		options.DownloadTimeout = DefaultDownloadTimeout
	}
	if options.Settle < 0 {
		options.Settle = 0
	}
	if options.Verify == nil {
		options.Verify = execVerify
	}
	if options.Env == nil {
		// Snapshotted once, and BEFORE the state directory is resolved: a nil map
		// reads as "no PDMUX_STATE_DIR", which would put the marker somewhere the
		// rest of the agent is not looking. internal/agent resolves the ledger's
		// directory the same way, from the same environment.
		options.Env = config.OSEnv()
	}
	if options.Ability == nil {
		options.Ability = func() protocol.AgentUpdateAbility { return Ability(options.Env, options.GOOS, os.Getppid()) }
	}
	if options.ExePath == "" {
		// A resolution failure is kept, not raised: it turns into EXE_NOT_WRITABLE
		// at accept time, which is a reported refusal rather than a dead handler.
		options.ExePath, _ = os.Executable()
	}
	stateDir := options.StateDir
	if stateDir == "" {
		stateDir = state.ResolveDir(state.DirInput{Env: options.Env})
	}
	return &Engine{opt: options, dir: filepath.Join(stateDir, "update")}
}

// Dir is where the marker, the attempt log and the lock live. Exported for the
// specs and for `doctor`, which should be able to point at it.
func (e *Engine) Dir() string { return e.dir }

// SetPanes wires the terminal counter after construction.
//
// It exists because of an ordering the wiring cannot avoid: the Engine is built
// FIRST (it is an argument to agent.New), but the panes it reports belong to the
// Agent that is built from it. Call it once, before Run — it is not a live
// switch, and nothing here re-reads it under a lock.
func (e *Engine) SetPanes(panes func() (shell, session int)) { e.opt.Panes = panes }

// HandleUpdate implements agent.UpdateHandler.
func (e *Engine) HandleUpdate(ctx context.Context, req agent.UpdateRequest) {
	if replay, busy := e.claim(req); busy {
		report(req, replay)
		return
	}
	final := e.run(ctx, req)
	e.finish(req.Update.CommandID, final)
	report(req, final)
	if final.Phase == protocol.PhaseRestarting {
		// Everything reversible is behind us: the new binary is installed, the
		// marker is on disk, and the server has been told to expect a reconnect.
		e.restart()
	}
}

// run walks the sequence and returns the TERMINAL status — `restarting` when the
// swap is committed, `failed` otherwise. Intermediate phases are reported as
// they happen, because a download of a 30MB artifact on a slow host is minutes
// of silence otherwise, and silence is what turns a working update into a
// support ticket.
func (e *Engine) run(ctx context.Context, req agent.UpdateRequest) protocol.UpdateStatus {
	update := req.Update

	// Refusals first, in cost order: everything here is a comparison or a stat,
	// and each one that fires saves a download.
	if err := e.precheck(update, req.CurrentVersion); err != nil {
		return e.failure(req, err)
	}

	// The lock is taken before anything is written. Two processes racing for the
	// same executable is not a hypothetical — a retry that arrives while the first
	// attempt is still downloading is the normal case.
	unlock, holder, err := acquireLock(e.dir, update.CommandID, os.Getpid(), e.opt.Now())
	if err != nil {
		if holder != "" {
			if holder == update.CommandID {
				// Same job, another process. We cannot know which phase that process
				// has reached, so we answer with the one thing that is certainly true
				// and start no second download.
				return e.progress(req, protocol.PhaseAccepted, nil, "", "this update is already running in another process")
			}
			return e.failure(req, refuse(CodeBusy, "another update (%s) is already running", holder))
		}
		return e.failure(req, refuse(CodeStateUnwritable, "cannot take the update lock: %v", err))
	}
	defer unlock()

	// The rate limiter is recorded HERE, after the refusals and under the lock: a
	// refused frame is not an attempt (the server may legitimately re-send a
	// corrected one), and counting outside the lock would let two racing frames
	// both see "2 so far".
	if err := recordAttempt(e.dir, update.Version, e.opt.Now(), e.opt.MaxAttempts, e.opt.RateWindow); err != nil {
		return e.failure(req, err)
	}

	// TERMINALS ATTACHED ARE A WARNING, NEVER A REFUSAL. On a dev fleet something
	// is always attached, so refusing would mean the button never works — and a
	// button that never works teaches people to reach for `force`, which is how a
	// safety rail becomes noise. The numbers go out with `accepted` so the UI can
	// put them in front of the person pressing it: plain shells and their children
	// die with the restart, multiplexer sessions survive and re-attach.
	shell, session := e.panes()
	if shell+session > 0 {
		e.opt.Logger.Warn("Updating with terminals attached",
			log.F("shellPanes", shell), log.F("sessionPanes", session))
	}
	accepted := e.progress(req, protocol.PhaseAccepted, nil, "", fmt.Sprintf("accepted update to %s", update.Version))
	accepted.ShellPanes = shell
	accepted.SessionPanes = session
	e.remember(accepted)
	report(req, accepted)

	// Staged BESIDE the executable: rename(2) cannot cross a filesystem, and the
	// state directory routinely lives on another one.
	staged := e.opt.ExePath + ".new"
	// A crashed earlier attempt can leave one behind. Removing it here rather than
	// refusing keeps a host from needing a human for a file only we ever write.
	_ = os.Remove(staged)

	report(req, e.progress(req, protocol.PhaseDownloading, intp(0), "", "downloading the new binary"))
	downloadCtx, cancelDownload := context.WithTimeout(ctx, e.opt.DownloadTimeout)
	defer cancelDownload()
	err = e.fetch(downloadCtx, update, staged, func(pct int) {
		report(req, e.progress(req, protocol.PhaseDownloading, intp(pct), "", "downloading the new binary"))
	})
	if err != nil {
		// The installed binary has not been touched. That is the invariant this
		// ordering buys, and the reason the download comes before anything else.
		_ = os.Remove(staged)
		return e.failure(req, err)
	}

	// GATE 1.
	report(req, e.progress(req, protocol.PhaseVerifying, intp(100), "", "verifying the new binary can connect"))
	verifyCtx, cancelVerify := context.WithTimeout(ctx, e.opt.VerifyTimeout)
	defer cancelVerify()
	if err := e.verify(verifyCtx, staged); err != nil {
		_ = os.Remove(staged)
		return e.failure(req, err)
	}

	report(req, e.progress(req, protocol.PhaseSwapping, intp(100), "", "installing the new binary"))

	// GATE 2 is armed BEFORE the rename, not after.
	//
	// The alternative ordering ("swap, then write the marker") has a window in
	// which the new binary is installed and unprotected: a crash there produces
	// exactly the outcome this package exists to prevent. Writing first has a
	// window too, but its failure is benign and detectable — the OLD binary starts,
	// finds a marker naming a version it is not, and clears it (CodeSwapIncomplete).
	// One window loses a host; the other loses a log line.
	deadline := e.opt.Now().Add(time.Duration(probationSec(update)) * time.Second)
	backup := e.opt.ExePath + ".bak"
	pending := Pending{
		CommandID:       update.CommandID,
		TargetVersion:   update.Version,
		PreviousVersion: req.CurrentVersion,
		ExePath:         e.opt.ExePath,
		BackupPath:      backup,
		DeadlineUnix:    deadline.Unix(),
		Attempts:        0,
	}
	if err := writePending(e.dir, pending); err != nil {
		_ = os.Remove(staged)
		return e.failure(req, refuse(CodeStateUnwritable, "cannot arm the probation marker: %v", err))
	}

	if err := swap(e.opt.ExePath, staged, backup); err != nil {
		// Un-arm: no swap happened, so a marker would make the next start of the
		// CURRENT binary look like a failed probation.
		_ = clearPending(e.dir)
		_ = os.Remove(staged)
		return e.failure(req, refuse(CodeSwapFailed, "%v", err))
	}

	e.opt.Logger.Info("Installed a new agent binary",
		log.F("version", update.Version),
		log.F("previous", req.CurrentVersion),
		log.F("backup", backup))

	return e.progress(req, protocol.PhaseRestarting, intp(100), "",
		fmt.Sprintf("restarting into %s (probation ends in %ds)", update.Version, probationSec(update)))
}

// restart ends the process so the service manager starts the new binary.
func (e *Engine) restart() {
	if e.opt.Settle > 0 {
		time.Sleep(e.opt.Settle)
	}
	// exit(0) and not a non-zero code: `Restart=always` relaunches either, but
	// `Restart=on-failure` — which an operator may well have edited in — relaunches
	// only a failure, and a clean exit is what both of our documented units expect.
	e.opt.Exit(0)
}

// claim enforces the in-process half of BUSY, and the idempotency the server's
// retry depends on.
func (e *Engine) claim(req agent.UpdateRequest) (protocol.UpdateStatus, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	id := req.Update.CommandID
	if e.running != nil {
		if e.running.commandID == id {
			// Re-emit the current phase. No new work: that is the whole contract of
			// an idempotency key.
			return e.running.status, true
		}
		return e.status(req, protocol.PhaseFailed, nil, CodeBusy,
			fmt.Sprintf("another update (%s) is already running", e.running.commandID)), true
	}
	if e.last != nil && e.last.commandID == id {
		// The outcome, again. A genuine retry uses a new commandId.
		return e.last.status, true
	}
	e.running = &job{commandID: id, status: e.status(req, protocol.PhaseAccepted, nil, "", "")}
	return protocol.UpdateStatus{}, false
}

func (e *Engine) finish(commandID string, status protocol.UpdateStatus) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.last = &job{commandID: commandID, status: status}
	e.running = nil
}

// progress records a phase as the current one and returns it, so the caller can
// report it. Recording is what makes a same-commandId repeat answerable.
func (e *Engine) progress(req agent.UpdateRequest, phase protocol.UpdatePhase, pct *int, code, message string) protocol.UpdateStatus {
	status := e.status(req, phase, pct, code, message)
	e.remember(status)
	return status
}

func (e *Engine) remember(status protocol.UpdateStatus) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.running != nil && e.running.commandID == status.CommandID {
		e.running.status = status
	}
}

// failure turns a refusal into the terminal `failed` status, and logs it. The
// log line matters: the frame may not reach a server that is itself the problem.
func (e *Engine) failure(req agent.UpdateRequest, err error) protocol.UpdateStatus {
	code, message := explain(err)
	e.opt.Logger.Warn("Refused a remote update",
		log.F("code", code),
		log.F("target", req.Update.Version),
		log.F("reason", message))
	return e.status(req, protocol.PhaseFailed, nil, code, message)
}

func (e *Engine) status(req agent.UpdateRequest, phase protocol.UpdatePhase, pct *int, code, message string) protocol.UpdateStatus {
	status := protocol.NewUpdateStatus()
	status.CommandID = req.Update.CommandID
	status.Phase = phase
	status.ProgressPct = pct
	// Truncated to the contract's caps rather than sent long: an over-long field
	// fails outbound validation, and a dropped frame is a silence — the one thing
	// the phase enum exists to prevent.
	status.CurrentVersion = clamp(req.CurrentVersion, 32)
	target := clamp(req.Update.Version, 32)
	status.TargetVersion = &target
	if code != "" {
		clamped := clamp(code, 64)
		status.Code = &clamped
	}
	status.Message = clamp(message, 512)
	return status
}

func (e *Engine) panes() (int, int) {
	if e.opt.Panes == nil {
		return 0, 0
	}
	shell, session := e.opt.Panes()
	return max(shell, 0), max(session, 0)
}

func (e *Engine) verify(ctx context.Context, candidate string) error {
	url, err := VerifyURL(e.opt.ServerURL)
	if err != nil {
		return refuse(CodeVerifyFailed, "cannot build a verify endpoint: %v", err)
	}
	e.opt.Logger.Info("Verifying the candidate binary", log.F("candidate", candidate), log.F("url", url))
	if err := e.opt.Verify(ctx, candidate, VerifySpec{URL: url, ConfigPath: e.opt.ConfigPath, Token: e.opt.Token}); err != nil {
		return refuse(CodeVerifyFailed, "%v", err)
	}
	return nil
}

// report is a nil-safe Report. A handler that panics here would take a pass
// goroutine down for a missing callback.
func report(req agent.UpdateRequest, status protocol.UpdateStatus) {
	if req.Report == nil || status.CommandID == "" {
		return
	}
	req.Report(status)
}

func probationSec(update protocol.AgentUpdate) int {
	if update.ProbationSec > 0 {
		return update.ProbationSec
	}
	return DefaultProbationSec
}

func intp(value int) *int { return &value }

// clamp truncates by BYTES, which is what the contract's `max()` counts for the
// ASCII these fields carry.
func clamp(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

// refusal is an error that already knows its reason code.
type refusal struct {
	code    string
	message string
}

func (r *refusal) Error() string { return r.message }

func refuse(code, format string, args ...any) error {
	return &refusal{code: code, message: fmt.Sprintf(format, args...)}
}

// explain reads the code out of an error, defaulting to the one that says
// "something went wrong and we do not have a name for it".
func explain(err error) (string, string) {
	var r *refusal
	if errors.As(err, &r) {
		return r.code, r.message
	}
	return CodeDownloadFailed, err.Error()
}
