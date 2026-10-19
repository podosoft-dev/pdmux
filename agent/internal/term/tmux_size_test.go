//go:build !windows

package term

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// liveManager drives a Manager the way the agent does, with the real PTY and
// the real tmux, and keeps what each terminal sent back.
type liveManager struct {
	manager *Manager

	mu     sync.Mutex
	output map[string]*strings.Builder
	exited map[string]bool
	failed map[string]string
}

func newLiveManager(t *testing.T) *liveManager {
	t.Helper()
	l := &liveManager{output: map[string]*strings.Builder{}, exited: map[string]bool{}, failed: map[string]string{}}
	l.manager = NewManager(Options{Send: l.receive})
	t.Cleanup(func() {
		l.manager.CloseAll()
		waitFor(t, ptyTimeout, "every viewer to exit", func() bool { return l.manager.Count() == 0 })
	})
	return l
}

func (l *liveManager) receive(frame protocol.TerminalServerFrame) {
	l.mu.Lock()
	defer l.mu.Unlock()
	switch f := frame.(type) {
	case *protocol.TerminalOutput:
		if l.output[f.TermID] == nil {
			l.output[f.TermID] = &strings.Builder{}
		}
		l.output[f.TermID].WriteString(f.Data)
	case *protocol.TerminalExit:
		l.exited[f.TermID] = true
	case *protocol.TerminalError:
		l.failed[f.TermID] = f.Message
	}
}

func (l *liveManager) open(t *testing.T, termID, session string, cols, rows int) {
	t.Helper()
	target := sessionTarget(&session)
	target.Cols, target.Rows = cols, rows
	l.manager.Handle(&protocol.TerminalOpen{Type: protocol.TermOpen, TermID: termID, Target: target})
	l.mu.Lock()
	failure, failed := l.failed[termID]
	l.mu.Unlock()
	if failed {
		t.Fatalf("open %s: %s", termID, failure)
	}
}

func (l *liveManager) resize(termID string, cols, rows int) {
	l.manager.Handle(&protocol.TerminalResize{Type: protocol.TermResize, TermID: termID, Cols: cols, Rows: rows})
}

func (l *liveManager) input(termID, data string) {
	l.manager.Handle(&protocol.TerminalInput{Type: protocol.TermInput, TermID: termID, Data: data})
}

func (l *liveManager) close(t *testing.T, termID string) {
	t.Helper()
	l.manager.Handle(&protocol.TerminalClose{Type: protocol.TermClose, TermID: termID})
	waitFor(t, ptyTimeout, termID+" to exit", func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		return l.exited[termID]
	})
}

func (l *liveManager) text(termID string) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.output[termID] == nil {
		return ""
	}
	return l.output[termID].String()
}

// Exercise actual tmux clients and kernel PTY resizes through the Manager, not
// a mock of argv. Every command reaches only the private server.
func TestTmuxSharedWindowSize(t *testing.T) {
	mux := newPrivateTmux(t)
	configuration := filepath.Join(mux.root, "tmux.conf")
	if err := os.WriteFile(configuration, []byte("set -g window-size smallest\nset -g status off\nset -g default-shell /bin/sh\nset -g default-command /bin/sh\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	mux.run(t, "-f", configuration, "new-session", "-d", "-s", "shared", "-x", "120", "-y", "40")
	mux.run(t, "new-session", "-d", "-s", "untouched")
	panePID := mux.run(t, "display-message", "-p", "-t", "=shared:", "#{pane_pid}")
	viewers := newLiveManager(t)

	size := func() string {
		return mux.run(t, "display-message", "-p", "-t", "=shared:", "#{window_width}x#{window_height}")
	}
	waitSize := func(t *testing.T, expected string) {
		t.Helper()
		waitFor(t, 2*time.Second, "shared window size "+expected+", current "+size(), func() bool { return size() == expected })
	}
	clients := func() []string {
		return strings.Fields(mux.run(t, "list-clients", "-t", "=shared", "-F", "#{client_width}x#{client_height}"))
	}
	// localPolicy is the window's own window-size and pdmux marker; empty means
	// the window inherits or carries none.
	localPolicy := func() (string, string) {
		return mux.run(t, "show-options", "-w", "-q", "-v", "-t", "=shared:", "window-size"),
			mux.run(t, "show-options", "-w", "-q", "-v", "-t", "=shared:", "@pdmux-window-size")
	}
	waitPolicy := func(t *testing.T, size, marker string) {
		t.Helper()
		var got, gotMarker string
		for deadline := time.Now().Add(ptyTimeout); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
			if got, gotMarker = localPolicy(); got == size && gotMarker == marker {
				return
			}
		}
		t.Fatalf("local window-size %q and marker %q, want %q and %q", got, gotMarker, size, marker)
	}
	defaultsIntact := func(t *testing.T) {
		t.Helper()
		if got := mux.run(t, "show-window-options", "-gv", "window-size"); got != "smallest" {
			t.Fatalf("global window-size changed to %q", got)
		}
		// An inherited option is absent from show-window-options; the global
		// value above remains the unrelated window's effective policy.
		if got := mux.run(t, "show-window-options", "-v", "-t", "=untouched:", "window-size"); got != "" {
			t.Fatalf("unrelated window gained a window-size override: %q", got)
		}
	}

	viewers.open(t, "large", "shared", 120, 40)
	waitSize(t, "120x40")
	viewers.open(t, "small", "shared", 60, 18)
	waitFor(t, ptyTimeout, "two independent viewers", func() bool { return len(clients()) == 2 })
	t.Run("[TC-PDTERM-022] a smaller viewer cannot shrink the shared program", func(t *testing.T) { waitSize(t, "120x40") })
	if t.Failed() {
		return
	}
	viewers.resize("small", 45, 12)
	waitFor(t, ptyTimeout, "the small client's actual resize", func() bool {
		return strings.Contains(strings.Join(clients(), " "), "45x12")
	})
	waitSize(t, "120x40")
	viewers.resize("large", 140, 44)
	waitSize(t, "140x44")
	t.Run("[TC-PDTERM-023] window policy leaves unrelated sessions and defaults intact", defaultsIntact)
	viewers.close(t, "large")
	waitSize(t, "45x12")
	t.Run("[TC-PDTERM-023] the policy stays while a pdmux viewer remains", func(t *testing.T) {
		if got, marker := localPolicy(); got != "largest" || marker != "inherit" {
			t.Fatalf("with one viewer left: window-size %q, marker %q", got, marker)
		}
	})
	viewers.input("small", "PDMUX_SHARED=retained; printf 'RESIZE_%s\\n' \"$PDMUX_SHARED\"\n")
	waitFor(t, ptyTimeout, "the shared shell's real output", func() bool { return strings.Contains(viewers.text("small"), "RESIZE_retained") })
	if got := mux.run(t, "display-message", "-p", "-t", "=shared:", "#{pane_pid}"); got != panePID {
		t.Fatalf("resize replaced the running shell: %s -> %s", panePID, got)
	}
	viewers.close(t, "small")
	waitFor(t, ptyTimeout, "both viewers to detach", func() bool {
		return mux.run(t, "display-message", "-p", "-t", "=shared:", "#{session_attached}") == "0"
	})
	t.Run("[TC-PDTERM-023] the last viewer's exit returns an inherited window to inheriting", func(t *testing.T) {
		waitPolicy(t, "", "")
		defaultsIntact(t)
	})

	viewers.open(t, "reopened", "shared", 100, 32)
	waitSize(t, "100x32")
	viewers.input("reopened", "printf 'REATTACHED_%s\\n' \"$PDMUX_SHARED\"\n")
	waitFor(t, ptyTimeout, "the original shell after reattachment", func() bool { return strings.Contains(viewers.text("reopened"), "REATTACHED_retained") })
	viewers.close(t, "reopened")
	waitPolicy(t, "", "")

	t.Run("[TC-PDTERM-023] the last viewer's exit restores the user's own window-size", func(t *testing.T) {
		mux.run(t, "set-option", "-w", "-t", "=shared:", "window-size", "smallest")
		viewers.open(t, "own-large", "shared", 120, 40)
		viewers.open(t, "own-small", "shared", 60, 18)
		waitFor(t, ptyTimeout, "two independent viewers", func() bool { return len(clients()) == 2 })
		waitSize(t, "120x40")
		viewers.close(t, "own-large")
		viewers.close(t, "own-small")
		waitPolicy(t, "smallest", "")
		defaultsIntact(t)
	})

	t.Run("[TC-PDTERM-023] a marker left by a stopped agent is restored, not overwritten", func(t *testing.T) {
		// What an agent that stopped while attached leaves behind: the policy in
		// force and the user's own value in the marker.
		mux.run(t, "set-option", "-w", "-t", "=shared:", "window-size", "largest")
		mux.run(t, "set-option", "-w", "-t", "=shared:", "@pdmux-window-size", "smallest")
		viewers.open(t, "restarted", "shared", 80, 24)
		waitFor(t, ptyTimeout, "the viewer to attach", func() bool { return len(clients()) == 1 })
		if got, marker := localPolicy(); got != "largest" || marker != "smallest" {
			t.Fatalf("after reattaching: window-size %q, marker %q", got, marker)
		}
		viewers.close(t, "restarted")
		waitPolicy(t, "smallest", "")
	})

	t.Run("[TC-PDTERM-023] a session the attach creates is restored to inheriting", func(t *testing.T) {
		policy := func() (string, string) {
			return mux.run(t, "show-options", "-w", "-q", "-v", "-t", "=created:", "window-size"),
				mux.run(t, "show-options", "-w", "-q", "-v", "-t", "=created:", "@pdmux-window-size")
		}
		viewers.open(t, "created", "created", 80, 24)
		waitFor(t, ptyTimeout, "the created session", func() bool {
			got, marker := policy()
			return got == "largest" && marker == "inherit"
		})
		viewers.close(t, "created")
		waitFor(t, ptyTimeout, "the created window to inherit again", func() bool {
			got, marker := policy()
			return got == "" && marker == ""
		})
		defaultsIntact(t)
	})
}
