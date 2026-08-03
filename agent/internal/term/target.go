package term

import (
	"os"
	"regexp"
	"strings"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"

	"github.com/podosoft-dev/pdmux/agent/internal/sys"
)

// SessionNamePattern is the class a multiplexer session name must fall in.
//
// ⚠ IT IS CHECKED HERE EVEN THOUGH THE CONTRACT ALREADY CHECKS IT. The value is
// about to become argv for `tmux`, and the frame reached us through a server
// that may have been built from a different version of the contract — terminal
// frames are also the one union the agent does not schema-validate on arrival
// (they arrive dozens per keystroke). One of the two layers is the one that
// happens to be right on the day they disagree, so both exist.
var SessionNamePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)

// DefaultSession is what an open with no session name attaches to.
const DefaultSession = "main"

// fallbackShell is used when $SHELL is unset or not an absolute path. A
// relative value would be resolved against PATH, which is not what a login
// shell should ever be picked by.
const fallbackShell = "/bin/bash"

// Resolved is the argv a PTY should start, plus a label for the log line.
type Resolved struct {
	File string
	Args []string
	// Label names the target for humans: `shell` or `session:<name>`. It is what
	// the log prints, so it must never grow to hold a path or a token.
	Label string
}

// MissingMultiplexerMessage is what a browser is told when a `session` terminal
// cannot start because there is no multiplexer on this host.
//
// ⚠ IT REPLACES A RAW GO ERROR THAT USED TO REACH THE SCREEN. What a person saw
// was `failed to open terminal: exec: "tmux": executable file not found in $PATH`
// — accurate, and useless: it names a variable they cannot see, in a process they
// did not start, and it does not say the shell option beside it still works.
//
// ⚠ AND IT DOES NOT TELL ANYONE TO INSTALL ANYTHING. What is on a host is that
// host owner's decision; this agent reports and does not provision. So the
// sentence states the fact and the alternative, and stops there.
const MissingMultiplexerMessage = "This host has no terminal multiplexer, so a session cannot be opened. A shell terminal works, but it ends when the connection does."

// InvalidTargetError is a target the agent refuses to start.
type InvalidTargetError struct {
	// Name is the offending session name, already truncated: it is echoed to the
	// browser in an error frame, and an unbounded string from the wire is not
	// something to hand back out.
	Name string
}

func (e *InvalidTargetError) Error() string {
	return "invalid session name: " + e.Name
}

// muxBinary is the multiplexer this agent knows how to drive. Named once so the
// collector, the doctor and the PTY cannot drift apart on it.
const muxBinary = "tmux"

// MultiplexerAvailable reports whether a `session` terminal can start at all.
//
// which is injected by specs; nil uses the real lookup, which searches PATH and
// then the places a person's own install lands — see sys.ResolveBinary. It has to
// be the same lookup the PTY will use, or this answers about a different tmux
// than the one that is about to be executed.
func MultiplexerAvailable(which func(string) (string, bool)) bool {
	if which == nil {
		which = sys.Which
	}
	_, found := which(muxBinary)
	return found
}

// ResolveTarget decides what a terminal actually attaches to.
//
//	session -> tmux new -A -s <name>   attach if it exists, create if not, so the
//	                                   work survives a dropped socket
//	shell   -> $SHELL -l               dies with the connection (the UI warns)
//
// That difference is why `session` is the default kind, and it matters more now
// than it did: a remote update restarts the agent, so every shell pane dies with
// it while every session pane re-attaches to work that kept running.
//
// getenv is injected by specs; nil reads the process environment.
func ResolveTarget(target protocol.TerminalTarget, getenv func(string) string) (Resolved, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	if target.Kind == protocol.TerminalShell {
		shell := getenv("SHELL")
		if !strings.HasPrefix(shell, "/") {
			shell = fallbackShell
		}
		return Resolved{File: shell, Args: []string{"-l"}, Label: "shell"}, nil
	}
	// Absent means `main`; present-but-empty is a name that fails the pattern, and
	// is refused rather than quietly turned into the default. The distinction is
	// the reason Session is a pointer in the contract.
	name := DefaultSession
	if target.Session != nil {
		name = *target.Session
	}
	if !SessionNamePattern.MatchString(name) {
		return Resolved{}, &InvalidTargetError{Name: truncate(name, 64)}
	}
	// `new -A` = attach if the session exists, create otherwise — one command for
	// both intents, so the browser never has to ask which case it is in.
	return Resolved{
		// Same resolution the session collector uses: PATH first, then where a
		// person's own install would be. A service manager's PATH has neither.
		File:  sys.ResolveBinary(muxBinary, ""),
		Args:  []string{"new", "-A", "-s", name},
		Label: "session:" + name,
	}, nil
}
