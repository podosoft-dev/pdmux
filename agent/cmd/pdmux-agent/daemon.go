package main

import (
	"context"

	"github.com/podosoft-dev/pdmux/agent/internal/agent"
	"github.com/podosoft-dev/pdmux/agent/internal/cli"
	"github.com/podosoft-dev/pdmux/agent/internal/update"
)

// runDaemon is the one line that joins the command surface to the agent runtime.
//
// The seam exists so internal/cli decides nothing about the daemon and the daemon
// decides nothing about argv — and so the CLI's specs never start one.
//
// It is also where the self-updater is assembled, and the ORDER BELOW IS PART OF
// THE DESIGN rather than a convenience:
//
//   - the engine is built and asked about a probation marker BEFORE anything
//     dials. A binary installed by a previous update is on trial, and the whole
//     value of the marker is that it is read on the host's own clock, with no
//     server involvement — a build that panics on start or is refused forever has
//     nothing to report to;
//   - `Startup` may answer "I restored the previous binary; end this process".
//     That is answered by RETURNING, not by exiting here: `run` owns the process,
//     and a clean return keeps the exit-code contract (0) that makes the service
//     manager start the restored binary;
//   - the panes are wired after the agent exists, because the engine is an
//     argument to agent.New and the terminals it reports belong to the agent
//     built from it.
func runDaemon(ctx context.Context, cfg cli.DaemonConfig) error {
	updater := update.New(update.Options{
		ServerURL: cfg.URL,
		Token:     cfg.Token,
		// This host's real config file, handed to a candidate binary during Gate 1.
		ConfigPath: cfg.ConfigPath,
		Version:    cfg.Version,
		Logger:     cfg.Logger,
	})

	// GATE 2, AND IT RUNS BEFORE THE NETWORK EXISTS. A rollback here has already
	// restored the previous binary and left the breadcrumb that binary reports on
	// its next connect; Startup logs what it decided, so there is nothing to add.
	if outcome := updater.Startup(); outcome.Exit {
		return nil
	}

	daemon := agent.New(agent.Options{
		URL:      cfg.URL,
		Token:    cfg.Token,
		Hostname: cfg.Hostname,
		Version:  cfg.Version,
		Logger:   cfg.Logger,
		Update:   updater,
		// The honest probe replaces the "no host can restart itself" default. It is
		// what decides whether the dashboard offers the button at all, and a wrong
		// `true` is the one answer that leaves a host stopped with no way back in —
		// so it says yes only for a supervisor that would actually relaunch us.
		UpdateAbility: update.HostAbility,
	})
	updater.SetPanes(daemon.TerminalPanes)
	return daemon.Run(ctx)
}
