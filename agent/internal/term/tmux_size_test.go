//go:build !windows

package term

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Exercise actual tmux clients and kernel PTY resizes, not a mock of argv.
// The private socket and empty TMUX keep the user's server out of every command.
func TestTmuxSharedWindowSize(t *testing.T) {
	binary, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux is required for the native multi-client regression")
	}
	root, err := os.MkdirTemp("/tmp", "pdmux-term-size-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	t.Setenv("TMUX", "")
	t.Setenv("TMUX_TMPDIR", root)
	t.Setenv("HOME", root)
	socket := filepath.Join(root, fmt.Sprintf("tmux-%d", os.Getuid()), "default")
	if err := os.MkdirAll(filepath.Dir(socket), 0o700); err != nil {
		t.Fatal(err)
	}
	configuration := filepath.Join(root, "tmux.conf")
	if err := os.WriteFile(configuration, []byte("set -g window-size smallest\nset -g status off\nset -g default-shell /bin/sh\nset -g default-command /bin/sh\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	mux := func(args ...string) string {
		t.Helper()
		output, err := exec.Command(binary, append([]string{"-S", socket}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("private tmux %v: %v: %s", args, err, output)
		}
		return strings.TrimSpace(string(output))
	}
	mux("-f", configuration, "new-session", "-d", "-s", "shared", "-x", "120", "-y", "40")
	t.Cleanup(func() { _ = exec.Command(binary, "-S", socket, "kill-server").Run() })
	mux("new-session", "-d", "-s", "untouched")
	panePID := mux("display-message", "-p", "-t", "=shared:", "#{pane_pid}")
	open := func(cols, rows int) (Process, *recorder) {
		t.Helper()
		name := "shared"
		resolved, err := ResolveTarget(sessionTarget(&name), nil)
		if err != nil {
			t.Fatal(err)
		}
		process, err := Spawn(Spec{File: resolved.File, Args: resolved.Args, Cols: cols, Rows: rows, Dir: root})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			process.Kill()
			select {
			case <-process.Exit():
			case <-time.After(ptyTimeout):
				t.Error("private tmux client did not stop")
			}
		})
		return process, record(process)
	}
	size := func() string {
		return mux("display-message", "-p", "-t", "=shared:", "#{window_width}x#{window_height}")
	}
	waitSize := func(t *testing.T, expected string) {
		t.Helper()
		waitFor(t, 2*time.Second, "shared window size "+expected+", current "+size(), func() bool { return size() == expected })
	}
	large, _ := open(120, 40)
	waitSize(t, "120x40")
	small, output := open(60, 18)
	waitFor(t, ptyTimeout, "two independent viewers", func() bool {
		return len(strings.Fields(mux("list-clients", "-t", "=shared", "-F", "#{client_width}x#{client_height}"))) == 2
	})
	t.Run("[TC-PDTERM-022] a smaller viewer cannot shrink the shared program", func(t *testing.T) { waitSize(t, "120x40") })
	if t.Failed() {
		return
	}
	if err := small.Resize(45, 12); err != nil {
		t.Fatal(err)
	}
	waitFor(t, ptyTimeout, "the small client's actual resize", func() bool {
		return strings.Contains(mux("list-clients", "-t", "=shared", "-F", "#{client_width}x#{client_height}"), "45x12")
	})
	waitSize(t, "120x40")
	if err := large.Resize(140, 44); err != nil {
		t.Fatal(err)
	}
	waitSize(t, "140x44")
	t.Run("[TC-PDTERM-023] window policy leaves unrelated sessions and defaults intact", func(t *testing.T) {
		if got := mux("show-window-options", "-gv", "window-size"); got != "smallest" {
			t.Fatalf("global window-size changed to %q", got)
		}
		// An inherited option is absent from show-window-options; the global
		// value above remains the unrelated window's effective policy.
		if got := mux("show-window-options", "-v", "-t", "=untouched:", "window-size"); got != "" {
			t.Fatalf("unrelated window gained a window-size override: %q", got)
		}
	})
	large.Kill()
	waitSize(t, "45x12")
	if err := small.Write("PDMUX_SHARED=retained; printf 'RESIZE_%s\\n' \"$PDMUX_SHARED\"\n"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, ptyTimeout, "the shared shell's real output", func() bool { return strings.Contains(output.text(), "RESIZE_retained") })
	if got := mux("display-message", "-p", "-t", "=shared:", "#{pane_pid}"); got != panePID {
		t.Fatalf("resize replaced the running shell: %s -> %s", panePID, got)
	}
	small.Kill()
	waitFor(t, ptyTimeout, "both viewers to detach", func() bool {
		return mux("display-message", "-p", "-t", "=shared:", "#{session_attached}") == "0"
	})
	reopened, reopenedOutput := open(100, 32)
	waitSize(t, "100x32")
	if err := reopened.Write("printf 'REATTACHED_%s\\n' \"$PDMUX_SHARED\"\n"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, ptyTimeout, "the original shell after reattachment", func() bool { return strings.Contains(reopenedOutput.text(), "REATTACHED_retained") })
}
