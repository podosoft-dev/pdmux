package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"
	"github.com/podosoft-dev/pdmux/agent/internal/session"
	"github.com/podosoft-dev/pdmux/agent/internal/term"
)

func TestNativeSessionCLI(t *testing.T) {
	t.Run("[TC-PDTERM-026] CLI and agent replacement preserve a native program without tmux", func(t *testing.T) {
		directory := t.TempDir()
		binary := filepath.Join(directory, "pdmux-agent")
		if runtime.GOOS == "windows" {
			binary += ".exe"
		}
		if supplied := os.Getenv("PDMUX_NATIVE_TEST_AGENT"); supplied != "" {
			bytes, err := os.ReadFile(supplied)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(binary, bytes, 0o700); err != nil {
				t.Fatal(err)
			}
		} else {
			build := exec.Command("go", "build", "-o", binary, ".")
			if output, err := build.CombinedOutput(); err != nil {
				t.Fatalf("build real agent: %v: %s", err, output)
			}
		}
		root := filepath.Join(directory, "engine")
		client := &session.Client{Root: root, Executable: binary}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		var outputMu sync.Mutex
		var output []byte
		t.Cleanup(func() {
			cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			reply, _ := client.Request(cleanup, session.Request{Action: "list"})
			for _, info := range reply.Sessions {
				_, _ = client.Request(cleanup, session.Request{Action: "terminate", ID: info.ID})
			}
			for i := 0; i < 100; i++ {
				if _, err := client.Request(cleanup, session.Request{Action: "shutdown"}); err == nil || err.Error() == "SESSION_ENGINE_NOT_RUNNING" {
					break
				}
				time.Sleep(20 * time.Millisecond)
			}
		})
		wait := func(label string, check func() bool) {
			t.Helper()
			for ctx.Err() == nil {
				if check() {
					return
				}
				time.Sleep(20 * time.Millisecond)
			}
			outputMu.Lock()
			defer outputMu.Unlock()
			t.Fatalf("native CLI timed out: %s; output: %s", label, ansi.Strip(string(output)))
		}
		// Neither the interactive client nor its detached engine can find tmux.
		environment := append(os.Environ(), "HOME="+directory, "SHELL=/bin/sh", "PATH="+directory,
			"PDMUX_DESKTOP_AGENT=1", "PDMUX_CONFIG=", "PDMUX_STATE_DIR="+filepath.Join(directory, "state"), "TMUX=", "TERM=xterm-256color")
		open := func(action string) term.Process {
			t.Helper()
			process, err := term.Spawn(term.Spec{File: binary, Args: []string{"session", action, "retained", "--root", root}, Cols: 100, Rows: 30, Dir: directory, Env: environment})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(process.Kill)
			go func() {
				for chunk := range process.Output() {
					outputMu.Lock()
					output = append(output, chunk...)
					if len(output) > 65536 {
						output = output[len(output)-65536:]
					}
					outputMu.Unlock()
				}
			}()
			return process
		}
		first := open("new")
		var original session.Info
		wait("first attachment", func() bool {
			reply, err := client.Request(ctx, session.Request{Action: "list"})
			if err != nil || len(reply.Sessions) != 1 || reply.Sessions[0].Attached != 1 {
				return false
			}
			original = reply.Sessions[0]
			return true
		})
		command := "PDMUX_RETAINED=STATE; printf 'BEFORE_%s\\n' \"$PDMUX_RETAINED\"\r"
		if runtime.GOOS == "windows" {
			command = "$env:PDMUX_RETAINED='STATE'; Write-Output ('BEFORE_' + $env:PDMUX_RETAINED)\r"
		}
		if err := first.Write(command); err != nil {
			t.Fatal(err)
		}
		hasHistory := func(marker string) bool {
			reply, err := client.Request(ctx, session.Request{Action: "history", ID: original.ID})
			return err == nil && strings.Contains(ansi.Strip(strings.Join(reply.Lines, "\n")), marker)
		}
		wait("initial shell output", func() bool { return hasHistory("BEFORE_STATE") })
		if _, err := client.Request(ctx, session.Request{Action: "shutdown"}); err == nil {
			t.Fatal("shutdown accepted a running program")
		}
		// Abrupt client termination is the desktop/network-agent crash boundary.
		first.Kill()
		wait("client detached", func() bool {
			reply, err := client.Request(ctx, session.Request{Action: "list"})
			return err == nil && len(reply.Sessions) == 1 && reply.Sessions[0].Attached == 0
		})
		// The engine owns an immutable copy. Replacing the source agent binary
		// must not replace the running helper or lose the program it owns.
		contents, err := os.ReadFile(binary)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(binary, binary+".previous"); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(binary, append(contents, 0), 0o700); err != nil {
			t.Fatal(err)
		}
		second := open("attach")
		wait("attachment from replacement agent", func() bool {
			reply, err := client.Request(ctx, session.Request{Action: "list"})
			if err != nil || len(reply.Sessions) != 1 {
				return false
			}
			info := reply.Sessions[0]
			if info.ID != original.ID || info.PID == nil || original.PID == nil || *info.PID != *original.PID {
				t.Fatal("replacement changed the program identity")
			}
			return info.Attached == 1
		})
		command = "printf 'AFTER_%s\\n' \"$PDMUX_RETAINED\"\r"
		if runtime.GOOS == "windows" {
			command = "Write-Output ('AFTER_' + $env:PDMUX_RETAINED)\r"
		}
		if err := second.Write(command); err != nil {
			t.Fatal(err)
		}
		wait("original shell environment", func() bool { return hasHistory("AFTER_STATE") })
		if err := second.Write("\x1dd"); err != nil {
			t.Fatal(err)
		}
		select {
		case code := <-second.Exit():
			if code == nil || *code != 0 {
				t.Fatalf("detach exit: %v", code)
			}
		case <-ctx.Done():
			t.Fatal("detach did not return")
		}
		if _, err := client.Request(ctx, session.Request{Action: "terminate", ID: original.ID}); err != nil {
			t.Fatal(err)
		}
		wait("explicit termination", func() bool {
			reply, err := client.Request(ctx, session.Request{Action: "list"})
			return err == nil && len(reply.Sessions) == 0
		})
	})
}
