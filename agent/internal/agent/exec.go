package agent

// Running one command on this host and reporting how it went.
//
// WHY THIS IS NOT A TERMINAL: a PTY session hands back the shell's prompt, its
// echo and ANSI escapes, and no exit status. A caller that has to decide whether
// a command succeeded cannot do it from that stream — which is exactly the
// judgement an automated caller makes. This pass trades interactivity for an
// answer.
//
// ⚠ NO SHELL IS INVOLVED. The contract carries the binary and its arguments
// separately and `sys.Run` execs the binary directly, so a semicolon in an
// argument is a semicolon in an argument. Assembling a command line here — even
// once, even "just for cwd" — would hand every caller a shell injection.

import (
	"context"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/log"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/sys"
)

// execSlots bounds how many commands may run at once.
//
// The other passes guard themselves with a single "already running" flag, but
// that shape is wrong here: two unrelated commands are a legitimate thing to ask
// for, while an unbounded number is how a caller turns the agent into a fork
// bomb on somebody's workstation. A refusal is an answer, so a caller that hits
// the ceiling is told rather than left waiting.
const execSlots = 4

// execOutputMax mirrors the contract's cap.
//
// ⚠ NOT `sys.DefaultMaxOutput` (32 MiB). That is the right number for output the
// agent consumes locally and the wrong one for output it puts on a websocket for
// a caller to read. Truncating here means the frame always validates; saying so
// in `truncated` means nobody reads a cut-off log as a finished one.
const execOutputMax = protocol.ExecOutputMax

// handleExec runs one command and sends its result, whatever happens.
//
// EVERY PATH ANSWERS. A caller is blocked on `commandId` until something comes
// back, so a refusal, a missing binary and a timeout are all results — silence
// is the one outcome that would leave it waiting forever.
func (a *Agent) handleExec(ctx context.Context, command protocol.AgentExec) {
	select {
	case a.execSlots <- struct{}{}:
		defer func() { <-a.execSlots }()
	default:
		a.sendExecRefusal(command, "EXEC_BUSY", "The agent is already running the maximum number of commands")
		return
	}

	if !a.client.Connected() {
		// Nowhere to send the answer, so running it would be pure side effect.
		return
	}

	cwd := ""
	if command.Cwd != nil {
		cwd = *command.Cwd
	}
	started := time.Now()
	/**
	 * ⚠ RESOLVED, NOT JUST LOOKED UP ON PATH. A service manager's PATH is not a
	 * person's: launchd hands the agent neither homebrew prefix, and systemd omits
	 * whatever a user installed under their home. The session collector already
	 * resolves the same way and for the same reason (`collect/sessions.go`), and the
	 * copy-mode control added on top of `exec` reaches `tmux` through this line — a
	 * macOS host would otherwise answer COMMAND_NOT_FOUND for a binary it has.
	 *
	 * Additive: an absolute path is returned untouched, a PATH hit wins first, and a
	 * genuinely missing binary comes back unchanged and still fails as COMMAND_NOT_FOUND.
	 */
	binary := sys.ResolveBinary(command.Command, "")
	outcome := sys.Run(ctx, binary, command.Args, sys.Options{
		TimeoutMs: command.TimeoutMs,
		Dir:       cwd,
		MaxOutput: execOutputMax,
	})

	result := protocol.NewExecResult()
	result.CommandID = command.CommandID
	result.ExitCode = outcome.Code
	result.Stdout, result.Truncated = clipOutput(outcome.Stdout)
	stderr, stderrCut := clipOutput(outcome.Stderr)
	result.Stderr = stderr
	result.Truncated = result.Truncated || stderrCut
	result.TimedOut = outcome.TimedOut
	if outcome.NotFound {
		// A fact about the host, not a failure of ours: the caller should install it
		// or call something else, and neither is helped by a bare exit code.
		code := "COMMAND_NOT_FOUND"
		result.Code = &code
		result.Message = "The command is not installed on this host"
	}

	a.logger.Info("Ran a command",
		log.F("command", command.Command),
		log.F("exitCode", result.ExitCode),
		log.F("timedOut", result.TimedOut),
		log.F("ms", time.Since(started).Milliseconds()))
	a.client.Send(&protocol.ExecResultFrame{Result: result})
}

// sendExecRefusal answers without running anything.
func (a *Agent) sendExecRefusal(command protocol.AgentExec, code string, message string) {
	result := protocol.NewExecResult()
	result.CommandID = command.CommandID
	// -1 is `sys.Run`'s own value for "never started", which is the truth here.
	result.ExitCode = -1
	result.Code = &code
	result.Message = message
	a.client.Send(&protocol.ExecResultFrame{Result: result})
}

// clipOutput cuts one stream to the contract's cap and says whether it had to.
//
// Cut at the END rather than the start: a caller reading a failure wants the
// command's first complaint, and the tail is what a runaway producer fills.
func clipOutput(text string) (string, bool) {
	if len(text) <= execOutputMax {
		return text, false
	}
	return text[:execOutputMax], true
}
