package term

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/session"
	"github.com/podosoft-dev/pdmux/agent/internal/sys"
)

// restoreRig is a manager with a real native helper (fake PTYs) and a tmux whose
// sessions the test states, recording every tmux spawn and every frame.
type restoreRig struct {
	manager *Manager
	client  *session.Client
	mu      sync.Mutex
	frames  []protocol.TerminalServerFrame
	spawns  []Spec
}

func newRestoreRig(t *testing.T, root string, which func(string) (string, bool), tmux func() (map[string]string, bool)) *restoreRig {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if root == "" {
		root = t.TempDir()
	}
	go func() {
		_ = session.Serve(ctx, root, "test", func(int, int, string) (session.Process, error) { return newFakePty(), nil })
	}()
	rig := &restoreRig{client: &session.Client{Root: root}}
	waitFor(t, 2*time.Second, "engine ready", func() bool {
		_, err := rig.client.Request(ctx, session.Request{Action: "ping"})
		return err == nil
	})
	rig.manager = NewManager(Options{
		Native:       rig.client,
		Which:        which,
		TmuxSessions: tmux,
		Spawn: func(spec Spec) (Process, error) {
			rig.mu.Lock()
			rig.spawns = append(rig.spawns, spec)
			rig.mu.Unlock()
			return newFakePty(), nil
		},
		Send: func(frame protocol.TerminalServerFrame) {
			rig.mu.Lock()
			rig.frames = append(rig.frames, frame)
			rig.mu.Unlock()
		},
	})
	t.Cleanup(rig.manager.CloseAll)
	return rig
}

func (r *restoreRig) ready(t *testing.T, termID string) *protocol.TerminalReady {
	t.Helper()
	var ready *protocol.TerminalReady
	waitFor(t, 2*time.Second, "ready or error", func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		for _, frame := range r.frames {
			switch f := frame.(type) {
			case *protocol.TerminalReady:
				if f.TermID == termID {
					ready = f
					return true
				}
			case *protocol.TerminalError:
				if f.TermID == termID {
					t.Fatalf("open failed: %s", f.Message)
				}
			}
		}
		return false
	})
	return ready
}

func (r *restoreRig) tmuxSpawns() []Spec {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Spec(nil), r.spawns...)
}

func savedTmux(id, name string) protocol.TerminalTarget {
	return protocol.TerminalTarget{Kind: protocol.TerminalSession, TmuxID: &id, Session: &name, Cols: 80, Rows: 24}
}

func listing(sessions map[string]string, ok bool) func() (map[string]string, bool) {
	return func() (map[string]string, bool) { return sessions, ok }
}

func TestRestoreSavedTmuxTarget(t *testing.T) {
	t.Run("[TC-PDTERM-161] a saved tmux session whose server is gone reopens as a native session", func(t *testing.T) {
		rig := newRestoreRig(t, "", muxInstalled, listing(map[string]string{}, true))
		rig.manager.Handle(&protocol.TerminalOpen{Type: protocol.TermOpen, TermID: "s12", Target: savedTmux("$0", "claude-1")})
		ready := rig.ready(t, "s12")
		if ready.Backend == nil || *ready.Backend != "native" || ready.SessionID == nil || ready.TmuxID != nil {
			t.Fatalf("ready = %+v, want a native session", ready)
		}
		if ready.Restored == nil || ready.Restored.Reason != "reboot" {
			t.Fatal("the pane was not told the session was reopened")
		}
		if len(rig.tmuxSpawns()) != 0 {
			t.Fatalf("tmux was started for a restore: %+v", rig.tmuxSpawns())
		}
		list, err := rig.client.Request(context.Background(), session.Request{Action: "list"})
		if err != nil || len(list.Sessions) != 1 || list.Sessions[0].Name != "claude-1" || list.Sessions[0].ID != *ready.SessionID {
			t.Fatalf("native session = %+v %v", list.Sessions, err)
		}
		// A second pane saved for the same tmux session lands on the same native one.
		rig.manager.Handle(&protocol.TerminalOpen{Type: protocol.TermOpen, TermID: "s13", Target: savedTmux("$0", "claude-1")})
		if again := rig.ready(t, "s13"); again.SessionID == nil || *again.SessionID != *ready.SessionID {
			t.Fatalf("second pane = %+v, want session %s", again, *ready.SessionID)
		}
	})

	t.Run("[TC-PDTERM-161] a host whose tmux binary is gone reopens as a native session", func(t *testing.T) {
		missing := func(string) (string, bool) { return "", false }
		rig := newRestoreRig(t, "", missing, nil)
		rig.manager.Handle(&protocol.TerminalOpen{Type: protocol.TermOpen, TermID: "s1", Target: savedTmux("$1", "w1")})
		if ready := rig.ready(t, "s1"); ready.Backend == nil || *ready.Backend != "native" || ready.Restored == nil {
			t.Fatalf("ready = %+v", ready)
		}
	})

	t.Run("[TC-PDTERM-162] a reused $N under another name is not attached", func(t *testing.T) {
		rig := newRestoreRig(t, "", muxInstalled, listing(map[string]string{"$0": "w1"}, true))
		rig.manager.Handle(&protocol.TerminalOpen{Type: protocol.TermOpen, TermID: "s12", Target: savedTmux("$0", "claude-1")})
		ready := rig.ready(t, "s12")
		if ready.Backend == nil || *ready.Backend != "native" || ready.Restored == nil {
			t.Fatalf("ready = %+v, want the saved name reopened natively", ready)
		}
		if len(rig.tmuxSpawns()) != 0 {
			t.Fatal("the pane was attached to a different tmux session that reused the id")
		}
	})

	t.Run("[TC-PDTERM-163] the saved id with its own name attaches tmux as before", func(t *testing.T) {
		rig := newRestoreRig(t, "", muxInstalled, listing(map[string]string{"$0": "claude-1"}, true))
		rig.manager.Handle(&protocol.TerminalOpen{Type: protocol.TermOpen, TermID: "s12", Target: savedTmux("$0", "claude-1")})
		ready := rig.ready(t, "s12")
		if ready.Restored != nil || ready.TmuxID == nil || *ready.TmuxID != "$0" {
			t.Fatalf("ready = %+v, want the live tmux session", ready)
		}
		if spawns := rig.tmuxSpawns(); len(spawns) != 1 || spawns[0].Args[0] != "attach-session" || spawns[0].Args[2] != "$0" {
			t.Fatalf("spawns = %+v", spawns)
		}
	})

	t.Run("[TC-PDTERM-163] a new session that reused the saved name is not joined", func(t *testing.T) {
		rig := newRestoreRig(t, "", muxInstalled, listing(map[string]string{"$0": "w1", "$4": "claude-1"}, true))
		rig.manager.Handle(&protocol.TerminalOpen{Type: protocol.TermOpen, TermID: "s12", Target: savedTmux("$0", "claude-1")})
		ready := rig.ready(t, "s12")
		if ready.Restored == nil || ready.Backend == nil || *ready.Backend != "native" || len(rig.tmuxSpawns()) != 0 {
			t.Fatalf("ready = %+v spawns = %+v, want a native reopen", ready, rig.tmuxSpawns())
		}
	})

	t.Run("[TC-PDTERM-164] an unknown tmux answer, or no saved name, keeps the saved target", func(t *testing.T) {
		rig := newRestoreRig(t, "", muxInstalled, listing(nil, false))
		rig.manager.Handle(&protocol.TerminalOpen{Type: protocol.TermOpen, TermID: "s12", Target: savedTmux("$0", "claude-1")})
		if ready := rig.ready(t, "s12"); ready.Restored != nil || ready.TmuxID == nil {
			t.Fatalf("ready = %+v", ready)
		}
		gone := newRestoreRig(t, "", muxInstalled, listing(map[string]string{}, true))
		id := "$0"
		gone.manager.Handle(&protocol.TerminalOpen{Type: protocol.TermOpen, TermID: "s9", Target: protocol.TerminalTarget{Kind: protocol.TerminalSession, TmuxID: &id, Cols: 80, Rows: 24}})
		if ready := gone.ready(t, "s9"); ready.Restored != nil || ready.TmuxID == nil {
			t.Fatalf("an id-only target (older server) changed behaviour: %+v", ready)
		}
	})

	t.Run("[TC-PDTERM-165] tmux's no-server answers are empty lists, other failures are unknown", func(t *testing.T) {
		cases := []struct {
			name   string
			result sys.Result
			want   map[string]string
			ok     bool
		}{
			{"listed", sys.Result{Stdout: "$0 claude-1\n$3 w1\n"}, map[string]string{"$0": "claude-1", "$3": "w1"}, true},
			{"no server", sys.Result{Code: 1, Stderr: "no server running on /tmp/tmux-1000/default\n"}, map[string]string{}, true},
			{"no socket", sys.Result{Code: 1, Stderr: "error connecting to /tmp/tmux-1000/default (No such file or directory)\n"}, map[string]string{}, true},
			{"no binary", sys.Result{Code: -1, NotFound: true}, map[string]string{}, true},
			{"timeout", sys.Result{Code: -1, TimedOut: true}, nil, false},
			{"other failure", sys.Result{Code: 1, Stderr: "lost server\n"}, nil, false},
		}
		for _, c := range cases {
			got, ok := parseTmuxSessions(c.result)
			if ok != c.ok || len(got) != len(c.want) {
				t.Fatalf("%s: %v %v", c.name, got, ok)
			}
			for id, name := range c.want {
				if got[id] != name {
					t.Fatalf("%s: %v", c.name, got)
				}
			}
		}
	})

	t.Run("[TC-PDTERM-166] a native pane whose session ended with the host's restart is reopened and announced", func(t *testing.T) {
		boot := sys.BootID()
		if boot == "" {
			t.Skip("this platform reports no boot identity, so restore is off")
		}
		root := t.TempDir()
		id := "d5ac0000-0000-4000-8000-000000000001"
		record := map[string]any{"version": 1, "entries": []map[string]any{{
			"uuid": id, "name": "w2", "cwd": "", "cols": 80, "rows": 24, "bootId": "an-earlier-boot", "updatedAt": time.Now().Unix(),
		}}}
		bytes, _ := json.Marshal(record)
		if err := os.MkdirAll(root, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, session.RestoreFile), bytes, 0o600); err != nil {
			t.Fatal(err)
		}
		rig := newRestoreRig(t, root, muxInstalled, nil)
		backend, intent, name := "native", "attach", "w2"
		rig.manager.Handle(&protocol.TerminalOpen{Type: protocol.TermOpen, TermID: "s14", Target: protocol.TerminalTarget{Kind: protocol.TerminalSession, Backend: &backend, Intent: &intent, Session: &name, SessionID: &id, Cols: 80, Rows: 24}})
		ready := rig.ready(t, "s14")
		if ready.SessionID == nil || *ready.SessionID != id || ready.Restored == nil || ready.Restored.Reason != "reboot" {
			t.Fatalf("ready = %+v", ready)
		}
	})
}
