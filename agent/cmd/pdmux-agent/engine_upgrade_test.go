package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"
	"github.com/podosoft-dev/pdmux/agent/internal/cli"
	"github.com/podosoft-dev/pdmux/agent/internal/session"
)

// Supply a historical helper and the candidate once; never build or restart a
// user's installed agent. Regular CI covers legacy IPC behavior in session tests.
func TestNativeLegacyEngineUpgrade(t *testing.T) {
	legacyBinary, candidate := os.Getenv("PDMUX_NATIVE_LEGACY_AGENT"), os.Getenv("PDMUX_NATIVE_TEST_AGENT")
	if legacyBinary == "" || candidate == "" {
		t.Skip("requires historical and candidate native agent binaries")
	}
	t.Run("[TC-PDUI-237] legacy rename preserves running shell state across an agent replacement", func(t *testing.T) {
		root := t.TempDir()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		legacy := exec.Command(legacyBinary, "session", "serve", "--root", root)
		legacy.Env = append(os.Environ(), "HOME="+root, "SHELL=/bin/sh", "TMUX=", "PDMUX_STATE_DIR="+filepath.Join(root, "state"))
		if err := legacy.Start(); err != nil {
			t.Fatal(err)
		}
		exited := make(chan struct{})
		go func() { _ = legacy.Wait(); close(exited) }()
		current := &session.Client{Root: root, Executable: candidate, Version: cli.AgentVersion}
		t.Cleanup(func() {
			cleanup, stop := context.WithTimeout(context.Background(), 3*time.Second)
			defer stop()
			list, _ := current.Request(cleanup, session.Request{Action: "list"})
			for _, info := range list.Sessions {
				_, _ = current.Request(cleanup, session.Request{Action: "terminate", ID: info.ID})
			}
			for i := 0; i < 100; i++ {
				_, err := current.Request(cleanup, session.Request{Action: "shutdown"})
				if err == nil || err.Error() == "SESSION_ENGINE_NOT_RUNNING" {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			_ = legacy.Process.Kill()
			<-exited
		})
		wait := func(label string, check func() bool) {
			t.Helper()
			deadline := time.Now().Add(5 * time.Second)
			for time.Now().Before(deadline) {
				if check() {
					return
				}
				time.Sleep(10 * time.Millisecond)
			}
			t.Fatalf("timed out: %s", label)
		}
		wait("old helper", func() bool { _, err := current.Request(ctx, session.Request{Action: "ping"}); return err == nil })
		ping, err := current.Request(ctx, session.Request{Action: "ping"})
		if err != nil {
			t.Fatal(err)
		}
		if ping.Version != "0.1.32" {
			t.Fatalf("expected historical 0.1.32, got %s", ping.Version)
		}
		// Open on the old helper before an updated client is introduced.
		old := &session.Client{Root: root}
		viewer, err := old.Attach(ctx, session.Request{Action: "create", Name: "retained", Cols: 100, Rows: 30})
		if err != nil {
			t.Fatal(err)
		}
		defer viewer.Close()
		original := viewer.Info
		historyContains := func(marker string) bool {
			reply, err := current.Request(ctx, session.Request{Action: "history", ID: original.ID})
			return err == nil && strings.Contains(ansi.Strip(strings.Join(reply.Lines, "\n")), marker)
		}
		command := "PDMUX_KEPT=alive; printf 'BEFORE_%s\\n' \"$PDMUX_KEPT\"\r"
		if runtime.GOOS == "windows" {
			command = "$env:PDMUX_KEPT='alive'; Write-Output ('BEFORE_' + $env:PDMUX_KEPT)\r"
		}
		if err := viewer.Send(session.Request{Action: "input", Data: command}); err != nil {
			t.Fatal(err)
		}
		wait("initial shell state", func() bool { return historyContains("BEFORE_alive") })
		if err := current.Ensure(ctx); err != nil {
			t.Fatal(err)
		}
		renamed, err := current.Request(ctx, session.Request{Action: "rename", ID: original.ID, Name: "work"})
		if err != nil || renamed.Info == nil || renamed.Info.Name != "work" {
			t.Fatalf("legacy rename: %+v %v", renamed, err)
		}
		viewer.Close()
		restarted := &session.Client{Root: root, Executable: candidate, Version: cli.AgentVersion}
		attached, err := restarted.Attach(ctx, session.Request{Action: "attach", Name: "work", Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		defer attached.Close()
		listing, err := exec.Command(candidate, "session", "list", "--root", root, "--json").Output()
		if err != nil {
			t.Fatal(err)
		}
		var listed []session.Info
		if err := json.Unmarshal(listing, &listed); err != nil || len(listed) != 1 || listed[0].Name != "work" || listed[0].ID != original.ID {
			t.Fatalf("updated CLI lost the shared name: %s %v", listing, err)
		}
		if attached.Info.ID != original.ID || attached.Info.PID == nil || original.PID == nil || *attached.Info.PID != *original.PID || attached.Info.Name != "work" {
			t.Fatal("rename/replacement changed the program")
		}
		command = "printf 'AFTER_%s\\n' \"$PDMUX_KEPT\"\r"
		if runtime.GOOS == "windows" {
			command = "Write-Output ('AFTER_' + $env:PDMUX_KEPT)\r"
		}
		if err := attached.Send(session.Request{Action: "input", Data: command}); err != nil {
			t.Fatal(err)
		}
		wait("retained shell state", func() bool { return historyContains("AFTER_alive") })
		ping, err = restarted.Request(ctx, session.Request{Action: "ping"})
		if err != nil || ping.Version != "0.1.32" {
			t.Fatal("busy helper was replaced")
		}
		if _, err := restarted.Request(ctx, session.Request{Action: "terminate", ID: original.ID}); err != nil {
			t.Fatal(err)
		}
		wait("owned shell exit", func() bool {
			reply, err := restarted.Request(ctx, session.Request{Action: "list"})
			return err == nil && len(reply.Sessions) == 0
		})
		t.Run("[TC-PDTERM-026] concurrent clients automatically replace the idle historical helper", func(t *testing.T) {
			// [TC-PDTERM-026] The next open uses the candidate after the old engine is idle.
			results := make(chan error, 2)
			for range 2 {
				go func() {
					peer := &session.Client{Root: root, Executable: candidate, Version: cli.AgentVersion}
					results <- peer.Ensure(ctx)
				}()
			}
			for range 2 {
				if err := <-results; err != nil {
					t.Fatal(err)
				}
			}
			ping, err = restarted.Request(ctx, session.Request{Action: "ping"})
			if err != nil || ping.Version != cli.AgentVersion {
				t.Fatalf("idle upgrade: %+v %v", ping, err)
			}
			select {
			case <-exited:
			case <-time.After(time.Second):
				t.Fatal("idle historical helper did not exit")
			}
		})
		t.Logf("legacy=%s candidate=%s preserved UUID=%s PID=%d; automatic idle upgrade passed", "0.1.32", cli.AgentVersion, original.ID, *original.PID)
	})
}
