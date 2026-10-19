//go:build !windows

package session_test

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/charmbracelet/x/ansi"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/session"
	"github.com/podosoft-dev/pdmux/agent/internal/term"
)

func TestExistingTmuxCoexistence(t *testing.T) {
	t.Run("[TC-PDTERM-023] same-name native and existing tmux sessions stay independent", func(t *testing.T) {
		binary, err := exec.LookPath("tmux")
		if err != nil {
			t.Skip("tmux is required for coexistence verification")
		}
		root, err := os.MkdirTemp("/tmp", "pdmux-coexist-")
		if err != nil {
			t.Fatal(err)
		}
		defer os.RemoveAll(root)
		socket := filepath.Join(root, "existing.sock")
		t.Setenv("HOME", root)
		t.Setenv("SHELL", "/bin/sh")
		t.Setenv("TMUX", "")
		mux := func(args ...string) string {
			t.Helper()
			command := exec.Command(binary, append([]string{"-S", socket}, args...)...)
			output, err := command.CombinedOutput()
			if err != nil {
				t.Fatalf("private tmux %v: %v: %s", args, err, output)
			}
			return strings.TrimSpace(string(output))
		}
		mux("-f", "/dev/null", "new-session", "-d", "-s", "same", "-x", "100", "-y", "30", "/bin/sh")
		defer exec.Command(binary, "-S", socket, "kill-server").Run()
		mux("set-window-option", "-g", "window-size", "smallest")
		mux("set-option", "-t", "same", "status", "off")
		mux("send-keys", "-t", "=same:", "TMUX_ONLY=EXISTING_STATE", "Enter")
		server := mux("display-message", "-p", "-t", "=same:", "#{pid}")
		pane := mux("display-message", "-p", "-t", "=same:", "#{pane_pid}")
		global := mux("show-options", "-g") + mux("show-window-options", "-g")
		window := mux("show-window-options", "-t", "=same:")
		// Simulate an agent launched inside an existing tmux session. All setup
		// and cleanup commands still name the private socket explicitly.
		t.Setenv("TMUX", fmt.Sprintf("%s,%s,0", socket, server))
		engine := session.NewEngine(factory)
		defer engine.Close()
		view, info, err := engine.Open(session.Request{Action: "create", Name: "same", Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		defer view.Close()
		if info.PID == nil || fmt.Sprint(*info.PID) == pane {
			t.Fatal("native engine reused the tmux process")
		}
		if err := view.Apply(session.Request{Action: "input", Data: "NATIVE_ONLY=NATIVE_STATE; printf 'native:%s\\n' \"$NATIVE_ONLY\"\r"}); err != nil {
			t.Fatal(err)
		}
		eventually(t, func() bool {
			lines, _, _ := engine.History(info.ID)
			return strings.Contains(ansi.Strip(strings.Join(lines, "\n")), "native:NATIVE_STATE")
		})
		_ = view.Apply(session.Request{Action: "resize", Cols: 45, Rows: 12})
		view.Close()
		reopened, again, err := engine.Open(session.Request{Action: "attach", ID: info.ID, Cols: 120, Rows: 40})
		if err != nil {
			t.Fatal(err)
		}
		defer reopened.Close()
		if *again.PID != *info.PID {
			t.Fatal("native reconnect replaced the shell")
		}
		if err := engine.Terminate(info.ID); err != nil {
			t.Fatal(err)
		}
		eventually(t, func() bool { return len(engine.List()) == 0 })
		if got := mux("display-message", "-p", "-t", "=same:", "#{pid}|#{pane_pid}"); got != server+"|"+pane {
			t.Fatalf("existing tmux processes changed: %s", got)
		}
		if got := mux("show-options", "-g") + mux("show-window-options", "-g"); got != global {
			t.Fatal("native operations changed global tmux configuration")
		}
		if got := mux("show-window-options", "-t", "=same:"); got != window {
			t.Fatal("native operations changed the existing tmux window")
		}
		// A legacy target with no backend must still attach to tmux. Read actual
		// output and check the program state, rather than only inspecting argv.
		name := "same"
		resolved, err := term.ResolveTarget(protocol.TerminalTarget{Kind: protocol.TerminalSession, Session: &name}, nil)
		if err != nil {
			t.Fatal(err)
		}
		legacy, err := term.Spawn(term.Spec{File: resolved.File, Args: resolved.Args, Cols: 100, Rows: 30})
		if err != nil {
			t.Fatal(err)
		}
		defer legacy.Kill()
		var mu sync.Mutex
		var output strings.Builder
		go func() {
			for data := range legacy.Output() {
				mu.Lock()
				output.Write(data)
				mu.Unlock()
			}
		}()
		if err := legacy.Write("printf 'legacy:%s\\n' \"$TMUX_ONLY\"\r"); err != nil {
			t.Fatal(err)
		}
		eventually(t, func() bool {
			mu.Lock()
			defer mu.Unlock()
			return strings.Contains(ansi.Strip(output.String()), "legacy:EXISTING_STATE")
		})
		if got := mux("display-message", "-p", "-t", "=same:", "#{pane_pid}"); got != pane {
			t.Fatal("legacy attachment recreated the existing program")
		}
	})
}
