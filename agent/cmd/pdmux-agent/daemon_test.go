package main

// The daemon's own assembly, which is the one part of the update wiring no
// other package can reach: internal/update's specs perform the same sequence,
// but nothing there proves that THIS file performs it too.
//
// Only the ordering is checked here — Gate 2 before the network, and a decision
// to exit answered by returning cleanly. What the engine DOES is internal/update's
// subject, and duplicating it here would be a second implementation of the same
// assertions with a worse failure message.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/cli"
	"github.com/podosoft-dev/pdmux/agent/internal/log"
)

// unreachable is a port nothing answers on. It is what makes "did this return
// because Startup said so?" answerable: a run that got as far as dialling would
// still be retrying when the deadline expires.
const unreachable = "ws://127.0.0.1:1/agent/ws"

// armMarker writes a probation marker for `version` whose deadline has already
// passed, with the two paths a rollback touches pointing at a temp directory —
// never at the test binary, which is what os.Executable() resolves to here.
func armMarker(t *testing.T, stateDir, version string) (exe, backup string) {
	t.Helper()
	binDir := t.TempDir()
	exe = filepath.Join(binDir, "pdmux-agent")
	backup = exe + ".bak"
	if err := os.WriteFile(exe, []byte("#!/bin/sh\necho new\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(backup, []byte("#!/bin/sh\necho old\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(stateDir, "update")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	marker := map[string]any{
		"commandId":       "6f1a4c2e-8b3d-4a5f-9c7e-1d2b3a4c5d6e",
		"targetVersion":   version,
		"previousVersion": "0.1.0",
		"exePath":         exe,
		"backupPath":      backup,
		"deadlineUnix":    time.Now().Add(-time.Minute).Unix(),
	}
	data, err := json.Marshal(marker)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "pending.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	return exe, backup
}

func TestRunDaemon(t *testing.T) {
	t.Run("[TC-PDAGENT-073] rolls back and returns before it dials anything", func(t *testing.T) {
		stateDir := t.TempDir()
		t.Setenv("PDMUX_STATE_DIR", stateDir)
		exe, _ := armMarker(t, stateDir, "9.9.9")

		// A generous deadline that must NOT be reached: the endpoint is unreachable,
		// so an agent that got as far as Run would still be retrying when it expires.
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		start := time.Now()
		err := runDaemon(ctx, cli.DaemonConfig{
			URL:     unreachable,
			Token:   "agent-key",
			Version: "9.9.9",
			Logger:  log.Silent(),
		})

		if err != nil {
			t.Fatalf("runDaemon returned %v, want a clean return so the service manager starts the restored binary", err)
		}
		if ctx.Err() != nil {
			t.Fatal("runDaemon ran until its context expired; the rollback must end the process immediately")
		}
		if elapsed := time.Since(start); elapsed > 5*time.Second {
			t.Fatalf("runDaemon took %s to answer a rollback", elapsed)
		}
		if got, err := os.ReadFile(exe); err != nil || string(got) != "#!/bin/sh\necho old\n" {
			t.Fatalf("installed binary = %q (%v), want the restored previous one", got, err)
		}
		if _, err := os.Stat(filepath.Join(stateDir, "update", "pending.json")); err == nil {
			t.Fatal("the marker survived the rollback; the next start would roll back again")
		}
	})

	// Untagged: "keeps running when there is nothing to roll back" is the absence
	// of the behaviour above, and exists so the check cannot pass by returning
	// early for every host.
	t.Run("runs the agent when no update is on trial", func(t *testing.T) {
		t.Setenv("PDMUX_STATE_DIR", t.TempDir())

		ctx, cancel := context.WithTimeout(context.Background(), 750*time.Millisecond)
		defer cancel()
		if err := runDaemon(ctx, cli.DaemonConfig{
			URL:     unreachable,
			Token:   "agent-key",
			Version: "0.1.0",
			Logger:  log.Silent(),
		}); err != nil {
			t.Fatalf("runDaemon returned %v, want nil on a cancelled context", err)
		}
		if ctx.Err() == nil {
			t.Fatal("runDaemon returned before its context ended; a host with no marker must connect and stay")
		}
	})
}
