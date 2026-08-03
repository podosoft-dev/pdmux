package update

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/log"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/state"
)

// Gate 2: the probation marker.
//
// `pending.json` says "a binary was just installed and has not proved itself
// yet". The NEW binary reads it BEFORE IT TOUCHES THE NETWORK — that ordering is
// the whole mechanism. A build that panics on start, that cannot resolve its
// config, that segfaults in a library, or that dials and is refused forever, all
// look identical from the server (nothing arrives); the marker is what lets the
// host answer that question locally, on its own clock, with no server
// involvement at all.
//
// IT IS CLEARED AT `welcome`, NOT AT PROCESS START. "It started" is exactly the
// evidence that is not worth anything here: a binary that starts and cannot
// connect is the failure being defended against. A completed handshake is the
// same bar the old binary was meeting a minute ago, so it is the honest commit
// point.
//
// ⚠ ITS HONEST LIMIT: a marker only protects a host whose ALREADY-INSTALLED
// binary knows how to read one. The first update away from a build that predates
// this package is covered by Gate 1 and nothing else. Do not let that argue Gate
// 1 away — it argues for keeping both.

const (
	pendingFile = "pending.json"
	// reportFile is the breadcrumb a rollback leaves for the RESTORED binary to
	// find. Without it the rollback is invisible: the old agent reconnects, the
	// dashboard sees the version it always saw, and nobody learns the new build
	// was broken.
	reportFile = "report.json"
)

// CodeRollbackFailed is the worst case Gate 2 can reach: probation expired, the
// backup could not be restored. Reported rather than retried forever.
const CodeRollbackFailed = "ROLLBACK_FAILED"

// Pending is the marker's contents.
type Pending struct {
	CommandID       string `json:"commandId"`
	TargetVersion   string `json:"targetVersion"`
	PreviousVersion string `json:"previousVersion"`
	ExePath         string `json:"exePath"`
	BackupPath      string `json:"backupPath"`
	// DeadlineUnix is when probation ends, computed from the frame's probationSec
	// at swap time. Absolute rather than a duration: the host may be off for an
	// hour between the swap and the next start, and probation is a wall-clock
	// promise to the operator watching the dashboard.
	DeadlineUnix int64 `json:"deadlineUnix"`
	// Attempts counts STARTS of the new binary, incremented before any network.
	// It is what catches a crash loop that never reaches the deadline.
	Attempts int `json:"attempts"`
}

// StartupAction is what Startup decided.
type StartupAction string

const (
	// StartupNormal is "nothing to do" — no marker, or one that is not ours.
	StartupNormal StartupAction = "normal"
	// StartupProbation is "a marker is armed and this process is on trial".
	StartupProbation StartupAction = "probation"
	// StartupRolledBack is "probation failed, the previous binary is installed
	// again" — the caller must exit so the service manager starts it.
	StartupRolledBack StartupAction = "rolledBack"
)

// StartupOutcome is Startup's answer.
type StartupOutcome struct {
	Action StartupAction
	// Exit is true when this process must end (cleanly) instead of connecting.
	Exit bool
	// Deadline is when probation ends, for logging.
	Deadline time.Time
	Attempts int
	Detail   string
}

// Startup runs BEFORE the agent dials anything.
//
// It is the only method on this Engine that is allowed to end the process, and
// it does so by asking rather than by calling exit: the caller owns the
// process's lifetime, and a package that calls os.Exit inside a library function
// cannot be tested.
func (e *Engine) Startup() StartupOutcome {
	pending, ok, err := readPending(e.dir)
	if err != nil {
		// An unreadable marker must not stop the agent starting. It costs Gate 2,
		// which is the backstop, and the log line is how it gets noticed.
		e.opt.Logger.Warn("Ignoring an unreadable update marker", log.F("error", err))
		_ = clearPending(e.dir)
		return StartupOutcome{Action: StartupNormal}
	}
	if !ok {
		return StartupOutcome{Action: StartupNormal}
	}

	if pending.TargetVersion != e.opt.Version {
		// We are not the binary the marker is about. Either the swap never happened
		// (a crash between arming the marker and the rename — the benign window the
		// ordering was chosen to leave) or something else replaced the binary since.
		// Either way the running binary is not on trial, so the marker goes.
		e.opt.Logger.Warn("Clearing an update marker that names another version",
			log.F("marker", pending.TargetVersion), log.F("running", e.opt.Version))
		_ = clearPending(e.dir)
		e.writeReport(pendingReport{
			CommandID:     pending.CommandID,
			Phase:         string(protocol.PhaseFailed),
			Code:          CodeSwapIncomplete,
			TargetVersion: pending.TargetVersion,
			Message: fmt.Sprintf("the swap to %s did not take effect; %s is still installed",
				pending.TargetVersion, e.opt.Version),
		})
		return StartupOutcome{Action: StartupNormal}
	}

	// Counted BEFORE the network, and persisted immediately: a binary that
	// crashes during startup must still burn an attempt, or a crash loop would
	// wait out the entire deadline restarting every second.
	pending.Attempts++
	if err := writePending(e.dir, pending); err != nil {
		e.opt.Logger.Warn("Cannot record a probation attempt", log.F("error", err))
	}

	deadline := time.Unix(pending.DeadlineUnix, 0)
	now := e.opt.Now()
	switch {
	case pending.DeadlineUnix > 0 && now.After(deadline):
		return e.rollback(pending, CodeProbationExpired,
			fmt.Sprintf("%s did not complete a handshake before probation ended", pending.TargetVersion))
	case pending.Attempts > e.opt.MaxAttempts:
		return e.rollback(pending, CodeProbationAttempts,
			fmt.Sprintf("%s failed to complete a handshake in %d starts", pending.TargetVersion, e.opt.MaxAttempts))
	}

	e.opt.Logger.Info("Starting on probation",
		log.F("version", pending.TargetVersion),
		log.F("attempt", pending.Attempts),
		log.F("deadline", deadline.UTC().Format(time.RFC3339)))
	return StartupOutcome{
		Action:   StartupProbation,
		Deadline: deadline,
		Attempts: pending.Attempts,
		Detail:   fmt.Sprintf("on probation until %s", deadline.UTC().Format(time.RFC3339)),
	}
}

// rollback restores the previous binary and leaves the breadcrumb that turns
// this into a REPORTED outcome rather than a version that quietly went back.
func (e *Engine) rollback(pending Pending, code, detail string) StartupOutcome {
	report := pendingReport{
		CommandID:     pending.CommandID,
		Phase:         string(protocol.PhaseRolledBack),
		Code:          code,
		TargetVersion: pending.TargetVersion,
		Message:       detail,
	}
	outcome := StartupOutcome{Action: StartupRolledBack, Exit: true, Attempts: pending.Attempts, Detail: detail}

	if err := restore(pending.ExePath, pending.BackupPath); err != nil {
		// Nothing left to fall back to. Clearing the marker is still right: another
		// exit-and-restart cycle would not restore anything either, and a host that
		// keeps exiting cannot even report why.
		e.opt.Logger.Error("Cannot roll back to the previous binary",
			log.F("backup", pending.BackupPath), log.F("error", err))
		_ = clearPending(e.dir)
		report.Phase = string(protocol.PhaseFailed)
		report.Code = CodeRollbackFailed
		report.Message = clamp(fmt.Sprintf("%s; and the backup could not be restored: %v", detail, err), 512)
		e.writeReport(report)
		// Do NOT exit: the broken binary is still the installed one, and staying up
		// is the only chance it has of reaching the server to say so.
		return StartupOutcome{Action: StartupNormal, Detail: report.Message}
	}

	_ = clearPending(e.dir)
	e.writeReport(report)
	e.opt.Logger.Error("Rolled back to the previous binary",
		log.F("target", pending.TargetVersion),
		log.F("previous", pending.PreviousVersion),
		log.F("reason", code))
	return outcome
}

// Connected is the commit point. The agent calls it once a `welcome` has
// arrived, with the same Report it gives an update handler.
//
// It reports in on-disk order — the breadcrumb from a PREVIOUS update first,
// then this process's own `done` — so a dashboard that receives both reads them
// in the order they happened.
func (e *Engine) Connected(reportStatus func(protocol.UpdateStatus)) {
	if reportStatus == nil {
		return
	}
	if breadcrumb, ok := e.takeReport(); ok {
		reportStatus(breadcrumb.status(e.opt.Version))
	}

	pending, ok, err := readPending(e.dir)
	if err != nil || !ok {
		return
	}
	if pending.TargetVersion != e.opt.Version {
		// Startup already dealt with this; nothing to commit.
		return
	}
	if err := clearPending(e.dir); err != nil {
		// Left armed, the marker would roll a perfectly healthy agent back at its
		// next restart. Say so loudly.
		e.opt.Logger.Error("Cannot clear the update marker after a successful handshake",
			log.F("error", err))
	}
	e.opt.Logger.Info("Update committed", log.F("version", pending.TargetVersion))

	status := protocol.NewUpdateStatus()
	status.CommandID = pending.CommandID
	status.Phase = protocol.PhaseDone
	status.CurrentVersion = clamp(e.opt.Version, 32)
	target := clamp(pending.TargetVersion, 32)
	status.TargetVersion = &target
	status.ProgressPct = intp(100)
	status.Message = clamp(fmt.Sprintf("updated from %s to %s", pending.PreviousVersion, pending.TargetVersion), 512)
	reportStatus(status)
}

// pendingReport is the breadcrumb. It is deliberately a different file from the
// marker: the marker says "I am on trial", the breadcrumb says "something
// already happened and nobody has been told".
type pendingReport struct {
	CommandID     string `json:"commandId"`
	Phase         string `json:"phase"`
	Code          string `json:"code"`
	TargetVersion string `json:"targetVersion"`
	Message       string `json:"message"`
}

func (r pendingReport) status(currentVersion string) protocol.UpdateStatus {
	status := protocol.NewUpdateStatus()
	status.CommandID = r.CommandID
	status.Phase = protocol.UpdatePhase(r.Phase)
	// The version that is running NOW, which after a rollback is the restored one
	// — that is the field the dashboard believes over its own stored row.
	status.CurrentVersion = clamp(currentVersion, 32)
	target := clamp(r.TargetVersion, 32)
	status.TargetVersion = &target
	code := clamp(r.Code, 64)
	status.Code = &code
	status.Message = clamp(r.Message, 512)
	return status
}

func (e *Engine) writeReport(report pendingReport) {
	data, err := json.Marshal(report)
	if err != nil {
		return
	}
	if err := state.WriteFilePrivate(filepath.Join(e.dir, reportFile), data); err != nil {
		e.opt.Logger.Warn("Cannot record the update outcome", log.F("error", err))
	}
}

// takeReport reads the breadcrumb and removes it. Removing it BEFORE the frame
// is sent is the safer half of an unavoidable choice: a report that is lost
// because the socket died is one missing line in a dashboard, while a report
// that is re-sent on every reconnect is a host that permanently claims to have
// rolled back.
func (e *Engine) takeReport() (pendingReport, bool) {
	path := filepath.Join(e.dir, reportFile)
	data, err := os.ReadFile(path)
	if err != nil {
		return pendingReport{}, false
	}
	_ = os.Remove(path)
	var report pendingReport
	if err := json.Unmarshal(data, &report); err != nil || report.CommandID == "" {
		return pendingReport{}, false
	}
	return report, true
}

func readPending(dir string) (Pending, bool, error) {
	data, err := os.ReadFile(filepath.Join(dir, pendingFile))
	if errors.Is(err, os.ErrNotExist) {
		return Pending{}, false, nil
	}
	if err != nil {
		return Pending{}, false, err
	}
	var pending Pending
	if err := json.Unmarshal(data, &pending); err != nil {
		return Pending{}, false, fmt.Errorf("update marker is not readable: %w", err)
	}
	if pending.TargetVersion == "" || pending.ExePath == "" {
		return Pending{}, false, errors.New("update marker is missing its target")
	}
	return pending, true, nil
}

func writePending(dir string, pending Pending) error {
	data, err := json.Marshal(pending)
	if err != nil {
		return err
	}
	// 0600 through a temp file and a rename: a marker half-written by a power cut
	// would parse as "no marker" and silently disable Gate 2.
	return state.WriteFilePrivate(filepath.Join(dir, pendingFile), data)
}

func clearPending(dir string) error {
	err := os.Remove(filepath.Join(dir, pendingFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
