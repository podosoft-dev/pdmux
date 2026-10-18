package term

import (
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"testing"
	"time"
)

const ptyTimeout = 10 * time.Second

func sessionTarget(name *string) protocol.TerminalTarget {
	target := protocol.NewTerminalTarget()
	target.Kind = protocol.TerminalSession
	target.Session = name
	return target
}

func waitFor(t *testing.T, timeout time.Duration, what string, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func shellTarget() protocol.TerminalTarget {
	target := protocol.NewTerminalTarget()
	target.Kind = protocol.TerminalShell
	return target
}
