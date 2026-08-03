package collect

// Multiplexer sessions on the host.
//
// WHY A MISSING TMUX IS NOT AN ERROR: most hosts that join a fleet have no
// multiplexer at all, and an agent that logs a failure every few seconds for a
// tool nobody installed trains its operator to ignore the log. No tmux means an
// empty list, which is the truth — plus one `mux.missing` diagnostic on the card
// (diagnostics.go), which is where that fact belongs.
//
// Ported from apps/agent/src/collect/sessions.ts.

import (
	"context"
	"math"
	"strconv"
	"strings"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/sys"
)

// SessionFormat is the tmux format string the parser below expects.
const SessionFormat = "#{session_name}|#{session_attached}|#{session_windows}"

// defaultSessionTimeoutMs bounds the tmux call. A wedged server must cost this
// pass its session list and nothing else.
const defaultSessionTimeoutMs = 4_000

// sessionNameMax is muxSession.name's maxLength in the contract. Truncating here
// means an absurd session name costs its own tail rather than the whole frame.
const sessionNameMax = 128

// SessionReading is the session list plus the one extra fact the same command
// already proves.
type SessionReading struct {
	Sessions []protocol.MuxSession
	// Present is whether a multiplexer is installed at all. The heartbeat already
	// runs this command every beat, so reporting `mux.missing` costs nothing
	// extra — which is the whole reason this reading is separate from the list.
	Present bool
}

// parseSessions reads `name|attached|windows` per line; unparsable counts fall
// back to 0.
func parseSessions(text string) []protocol.MuxSession {
	out := []protocol.MuxSession{}
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		parts := strings.Split(line, "|")
		name := truncateRunes(parts[0], sessionNameMax)
		// The contract requires a non-empty name; a nameless row would fail the
		// whole heartbeat, so it is dropped instead.
		if name == "" {
			continue
		}
		session := protocol.NewMuxSession()
		session.Name = name
		session.Attached = toCount(partAt(parts, 1))
		session.Windows = toCount(partAt(parts, 2))
		out = append(out, session)
	}
	return out
}

func partAt(parts []string, index int) string {
	if index >= len(parts) {
		return ""
	}
	return parts[index]
}

// toCount mirrors the TypeScript's Number()+floor: anything that is not a
// non-negative number is 0, because a count is the one field here where 0 is the
// truthful answer for "tmux told us nothing".
func toCount(value string) int {
	parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	// "NaN" and "Inf" PARSE in Go, and converting either to int is undefined
	// behaviour — so they are rejected explicitly rather than assumed away.
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed < 0 {
		return 0
	}
	if parsed > math.MaxInt32 {
		return math.MaxInt32
	}
	return int(parsed)
}

// resolveMux names the binary to run.
//
// Resolved rather than named: a multiplexer installed per-user or by a package
// manager is invisible to a service manager's PATH, and reporting `mux.missing`
// for a tmux that IS installed is the wrong answer twice over — the card gets a
// badge it should not have, and every `session` terminal is refused.
//
// ⚠ A VARIABLE BECAUSE THE NEGATIVE CASE CANNOT BE STAGED OTHERWISE. Two of the
// searched directories are absolute system prefixes, so a spec that clears PATH
// still finds the multiplexer the machine running the spec happens to have. This
// file's "no multiplexer" case did exactly that once — it passed by finding the
// real one — so the seam exists to let a spec state absence and mean it.
var resolveMux = func() string { return sys.ResolveBinary("tmux", "") }

// ReadSessions lists sessions and reports whether a multiplexer exists.
func ReadSessions(ctx context.Context, timeoutMs int) SessionReading {
	result := sys.Run(ctx, resolveMux(), []string{"list-sessions", "-F", SessionFormat},
		sys.Options{TimeoutMs: boundMs(timeoutMs, defaultSessionTimeoutMs)})
	if result.NotFound {
		return SessionReading{Sessions: []protocol.MuxSession{}, Present: false}
	}
	// Exit 1 with "no server running" is the ordinary state of a fresh host —
	// tmux IS installed, there is simply nothing running under it.
	if result.Code != 0 {
		return SessionReading{Sessions: []protocol.MuxSession{}, Present: true}
	}
	return SessionReading{Sessions: parseSessions(result.Stdout), Present: true}
}

// Sessions is ReadSessions for callers that only want the list.
func Sessions(ctx context.Context, timeoutMs int) []protocol.MuxSession {
	return ReadSessions(ctx, timeoutMs).Sessions
}

// truncateRunes clips to a rune count, never a byte count: half a rune is
// invalid UTF-8, and the contract's maxLength counts characters.
func truncateRunes(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max])
}
