package term

import (
	"context"
	"strings"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/sys"
)

// tmuxTargetState is what became of the tmux session a saved pane points at.
type tmuxTargetState int

const (
	// tmuxTargetAsSaved: open the target exactly as it arrived (today's path).
	tmuxTargetAsSaved tmuxTargetState = iota
	// tmuxTargetGone: the saved id does not exist with the saved name.
	tmuxTargetGone
)

// savedTmuxTarget decides whether a tmux target that carries BOTH an id and a
// name still names the session it was saved with: the id must exist and still
// carry that name.
//
// ⚠ THE ID ALONE IS NOT AN IDENTITY ACROSS A RESTART. tmux numbers sessions from
// $0 per server, so after a reboot the first session anybody starts is $0 again
// — and attaching `$0` would put a pane saved for `claude-1` on whatever that new
// session is. The id counts only together with the name it was saved with.
//
// Anything short of a definite answer keeps today's behaviour: a target without a
// name (an older server sends only the id), a host whose tmux cannot be asked, or
// an agent without native sessions to fall back on.
func (m *Manager) savedTmuxTarget(target protocol.TerminalTarget) tmuxTargetState {
	if target.Kind == protocol.TerminalShell || target.TmuxID == nil || target.Session == nil || m.nativeClient == nil {
		return tmuxTargetAsSaved
	}
	if !SessionNamePattern.MatchString(*target.Session) || !tmuxSessionIDPattern.MatchString(*target.TmuxID) {
		return tmuxTargetAsSaved
	}
	var sessions map[string]string
	if MultiplexerAvailable(m.which) {
		if m.tmuxSessions == nil {
			return tmuxTargetAsSaved
		}
		listed, ok := m.tmuxSessions()
		if !ok {
			return tmuxTargetAsSaved
		}
		sessions = listed
	}
	if sessions[*target.TmuxID] == *target.Session {
		return tmuxTargetAsSaved
	}
	// A different session that happens to carry the saved name is not joined
	// either: it was started by somebody after the original ended.
	return tmuxTargetGone
}

// hostTmuxSessions lists the host's tmux sessions as id -> name.
//
// "No server" is a definite, empty answer — it is exactly what a host looks like
// after a reboot. A timeout or any other failure is not an answer at all.
func hostTmuxSessions() (map[string]string, bool) {
	result := sys.Run(context.Background(), sys.ResolveBinary(muxBinary, ""),
		[]string{"list-sessions", "-F", "#{session_id} #{session_name}"},
		sys.Options{TimeoutMs: tmuxPolicyTimeoutMs, Env: spawnEnv()})
	return parseTmuxSessions(result)
}

func parseTmuxSessions(result sys.Result) (map[string]string, bool) {
	if result.TimedOut {
		return nil, false
	}
	if result.NotFound {
		return map[string]string{}, true
	}
	if result.Code != 0 {
		if strings.Contains(result.Stderr, "no server running") || strings.Contains(result.Stderr, "error connecting to") {
			return map[string]string{}, true
		}
		return nil, false
	}
	sessions := make(map[string]string)
	for _, line := range strings.Split(result.Stdout, "\n") {
		id, name, found := strings.Cut(strings.TrimSpace(line), " ")
		if found && tmuxSessionIDPattern.MatchString(id) {
			sessions[id] = name
		}
	}
	return sessions, true
}
