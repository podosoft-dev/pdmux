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
	"io"
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
	// Embedded agents are supervised by Electron through a lifetime pipe. EOF
	// cancels the daemon even when the parent crashes, without touching host agents.
	if os.Getenv("PDMUX_DESKTOP_AGENT") == "1" && (len(os.Args) < 2 || os.Args[1] != "session") {
		go func() { _, _ = io.Copy(io.Discard, os.Stdin); stop() }()
	}

	os.Exit(cli.Main(ctx, os.Args[1:], cli.Deps{
		Stdout: os.Stdout,
		Stderr: os.Stderr,
		Daemon: runDaemon,
	}))
}
