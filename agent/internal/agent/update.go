package agent

// The remote-update seam.
//
// The `update` frame and the `updateStatus` reply exist in the contract, and the
// TypeScript agent handled neither. This file is deliberately only the ROUTING:
// the frame reaches an injectable handler, and a build without one declines
// immediately. The real verify-then-commit updater is Phase 6 and plugs in
// through Options.Update without touching agent.go.
//
// WHY ROUTE A FRAME WE CANNOT ACT ON. Every outcome of an update is reported by
// an agent that is connected — that is the whole point of the phase enum — so
// the server never has to infer failure from silence. Silence is what turns a
// slow host into a false alarm. A build that cannot update itself must therefore
// say so, in the same shape the real updater will use.

import (
	"context"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// UpdateCode is a stable reason code, so the dashboard can group failures
// instead of matching on prose.
const UpdateCodeNotSupported = "NOT_SUPPORTED"

// UpdateRequest is everything an updater needs from the running agent, and
// nothing that would make it depend on the agent itself.
type UpdateRequest struct {
	Update protocol.AgentUpdate
	// CurrentVersion is what is running RIGHT NOW. Every status carries it
	// because the row the server stored can be stale — the update it is reacting
	// to may already have happened.
	CurrentVersion string
	// Report ships one `updateStatus` frame. It is safe to call from any
	// goroutine and may be called many times for one command: the phases are
	// progress as well as outcome.
	Report func(status protocol.UpdateStatus)
}

// UpdateHandler acts on an `update` frame.
//
// The context is the agent's run context: a handler that downloads must abandon
// the work when it is cancelled, because shutdown waits for this call to return.
// Idempotency is the handler's own — the contract makes `commandId` the key, and
// re-sending one must not start a second download.
type UpdateHandler interface {
	HandleUpdate(ctx context.Context, request UpdateRequest)
}

// UpdateCommitter is the OPTIONAL other half of an updater: the part that runs
// when a connection is ACCEPTED, rather than when a frame arrives.
//
// ⚠ `welcome` IS THE COMMIT POINT OF A SELF-UPDATE, NOT PROCESS START. A binary
// that starts and then cannot dial is precisely the failure a self-update has to
// defend against, so "it started" is the one piece of evidence worth nothing
// here. An updater that has just replaced the binary is holding a probation
// marker only a completed handshake may clear — and nothing else in the agent
// knows a handshake happened. Without this call it can never send `done` or
// `rolledBack`: the update either looks like it never finished, or rolls a
// healthy agent back at its next restart.
//
// It is a second interface rather than a method on UpdateHandler so every
// handler that has nothing to commit — UnsupportedUpdater, a spec's stub — keeps
// working untouched.
type UpdateCommitter interface {
	// Connected is called once per accepted connection, with the same Report an
	// update handler is given. It runs on the dispatch goroutine, so an
	// implementation must not block for long.
	Connected(report func(status protocol.UpdateStatus))
}

// UnsupportedUpdater is the default handler: it declines every update.
//
// This is not a stub that does nothing — doing nothing is exactly the failure
// mode the phase enum was designed to avoid. It answers.
type UnsupportedUpdater struct{}

// HandleUpdate reports one terminal `failed` status and returns.
func (UnsupportedUpdater) HandleUpdate(_ context.Context, request UpdateRequest) {
	status := protocol.NewUpdateStatus()
	// Echoed so a retry of the same command is recognisable as the same job.
	status.CommandID = request.Update.CommandID
	status.Phase = protocol.PhaseFailed
	status.CurrentVersion = request.CurrentVersion
	status.TargetVersion = &request.Update.Version
	status.Code = ptr(UpdateCodeNotSupported)
	status.Message = "this agent build cannot update itself"
	request.Report(status)
}

// NoUpdateAbility is the default answer to "could this host start itself again
// after replacing its binary": no.
//
// ⚠ Phase 6 supplies the real probe — systemd with `Restart=always`, launchd
// with `KeepAlive`. Until then the default must read as "do not offer the
// button": a remote update ends with the agent exiting, and with nothing to
// start it again that is a hole the host never climbs out of. The contract's own
// default for this object is the same `{canRestart: false, restartMode: "none"}`
// precisely so an agent built before remote update looks un-updatable rather
// than un-restartable-but-worth-a-try.
func NoUpdateAbility() protocol.AgentUpdateAbility {
	return protocol.NewAgentUpdateAbility()
}

// reportUpdateStatus ships one `updateStatus` frame. Both halves of the seam
// report through it — the handler's progress and the committer's outcome — so
// there is one place that knows how a status reaches the server.
func (a *Agent) reportUpdateStatus(status protocol.UpdateStatus) {
	a.client.Send(&protocol.UpdateStatusFrame{Update: status})
}

// commitUpdate tells an updater that this connection was accepted. A handler
// that is not a committer (the default, and every spec's stub) is skipped.
func (a *Agent) commitUpdate() {
	if committer, ok := a.update.(UpdateCommitter); ok {
		committer.Connected(a.reportUpdateStatus)
	}
}

// handleUpdate routes one frame to the seam.
func (a *Agent) handleUpdate(update protocol.AgentUpdate) {
	request := UpdateRequest{
		Update:         update,
		CurrentVersion: a.version,
		Report:         a.reportUpdateStatus,
	}
	// Off the read loop: a real update downloads, hashes and swaps a binary, and
	// the read loop is what answers the server's ping in the meantime.
	a.spawnPass("update", func(ctx context.Context) {
		a.update.HandleUpdate(ctx, request)
	})
}

func ptr[T any](value T) *T { return &value }
