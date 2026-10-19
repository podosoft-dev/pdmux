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
