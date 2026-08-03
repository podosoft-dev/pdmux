// Command pdmux-agent is the host agent: one outbound WebSocket to a pdmux
// dashboard, reporting metrics, sessions, usage and read-only git snapshots, and
// relaying the terminal frames the server sends back.
//
// Wiring only. Every decision it makes lives in internal/cli next door, so this
// file has nothing worth mocking.
//
// Ported from apps/agent/src/main.ts.
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/podosoft-dev/pdmux/agent/internal/cli"
)

func main() {
	// NotifyContext, not a handler that calls os.Exit: everything the agent owns —
	// child processes in a PTY, a socket the server watches — is torn down by the
	// cancellation travelling down to the daemon, and a bare exit would leave the
	// server waiting out its sweep to notice this host went away on purpose.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	os.Exit(cli.Main(ctx, os.Args[1:], cli.Deps{
		Stdout: os.Stdout,
		Stderr: os.Stderr,
		Daemon: runDaemon,
	}))
}
