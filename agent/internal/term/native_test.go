package term

import (
	"context"
	"testing"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/session"
)

func TestNativeLateAttachment(t *testing.T) {
	t.Run("[TC-PDTERM-023] disconnect during startup cannot leak a late native viewer", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		entered, proceed := make(chan struct{}), make(chan struct{})
		root := t.TempDir()
		finished := make(chan error, 1)
		go func() {
			finished <- session.Serve(ctx, root, "test", func(int, int, string) (session.Process, error) { close(entered); <-proceed; return newFakePty(), nil })
		}()
		client := &session.Client{Root: root}
		waitFor(t, time.Second, "engine ready", func() bool { _, err := client.Request(ctx, session.Request{Action: "ping"}); return err == nil })
		manager := NewManager(Options{Native: client})
		backend, intent, name := "native", "create", "late"
		opened := make(chan struct{})
		go func() {
			defer close(opened)
			manager.Handle(&protocol.TerminalOpen{Type: protocol.TermOpen, TermID: "late", Target: protocol.TerminalTarget{Kind: protocol.TerminalSession, Backend: &backend, Intent: &intent, Session: &name, Cols: 80, Rows: 24}})
		}()
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("session did not begin spawning")
		}
		manager.CloseAll()
		close(proceed)
		select {
		case <-opened:
		case <-time.After(time.Second):
			t.Fatal("open did not return")
		}
		if manager.Count() != 0 {
			t.Fatal("late attachment survived disconnect")
		}
		waitFor(t, time.Second, "late viewer detached", func() bool {
			reply, err := client.Request(ctx, session.Request{Action: "list"})
			return err == nil && len(reply.Sessions) == 1 && reply.Sessions[0].Attached == 0
		})
		cancel()
		select {
		case err := <-finished:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(time.Second):
			t.Fatal("engine did not stop")
		}
	})
}

func TestNativeRenameControl(t *testing.T) {
	t.Run("[TC-PDUI-237] rename crosses authenticated IPC and never restarts a process", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		root := t.TempDir()
		go func() {
			_ = session.Serve(ctx, root, "test", func(int, int, string) (session.Process, error) { return newFakePty(), nil })
		}()
		client := &session.Client{Root: root}
		waitFor(t, time.Second, "engine ready", func() bool { _, err := client.Request(ctx, session.Request{Action: "ping"}); return err == nil })
		viewer, err := client.Attach(ctx, session.Request{Action: "create", Name: "old", Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		defer viewer.Close()
		results := make(chan *protocol.TerminalSessionResult, 1)
		manager := NewManager(Options{Native: client, Send: func(frame protocol.TerminalServerFrame) {
			if result, ok := frame.(*protocol.TerminalSessionResult); ok {
				results <- result
			}
		}})
		name := "renamed"
		manager.Handle(&protocol.TerminalSessionControl{Type: protocol.TermSessionControl, TermID: "rename", SessionID: viewer.Info.ID, Action: "rename", Name: &name})
		select {
		case result := <-results:
			if result.Error != "" || result.Name == nil || *result.Name != name {
				t.Fatalf("rename failed: %+v", result)
			}
		case <-time.After(time.Second):
			t.Fatal("no rename acknowledgement")
		}
		list, err := client.Request(ctx, session.Request{Action: "list"})
		if err != nil || len(list.Sessions) != 1 || list.Sessions[0].Name != name || list.Sessions[0].ID != viewer.Info.ID || list.Sessions[0].Attached != 1 {
			t.Fatalf("changed session identity: %+v %v", list, err)
		}
	})
}
