package session_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/session"
	"github.com/podosoft-dev/pdmux/agent/internal/term"
)

func factory(cols, rows int, directory string) (session.Process, error) {
	resolved, err := term.ResolveTarget(protocol.TerminalTarget{Kind: protocol.TerminalShell}, nil)
	if err != nil {
		return nil, err
	}
	return term.Spawn(term.Spec{File: resolved.File, Args: resolved.Args, Cols: cols, Rows: rows, Dir: directory})
}

func eventually(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("native session condition did not become true")
}

func TestNativePersistence(t *testing.T) {
	t.Run("[TC-PDTERM-023] native attachment preserves a shell without tmux", func(t *testing.T) {
		engine := session.NewEngine(factory)
		defer engine.Close()
		large, info, err := engine.Open(session.Request{Action: "create", Name: "native", Cols: 120, Rows: 40})
		if err != nil {
			t.Fatal(err)
		}
		defer large.Close()
		if err := large.Apply(session.Request{Action: "input", Data: "echo NATIVE_SESSION_OK\r"}); err != nil {
			t.Fatal(err)
		}
		eventually(t, func() bool {
			lines, _, _ := engine.History(info.ID)
			return strings.Contains(ansi.Strip(strings.Join(lines, "\n")), "NATIVE_SESSION_OK")
		})
		large.Close()
		if len(engine.List()) != 1 {
			t.Fatal("disconnect ended the session")
		}
		reopened, again, err := engine.Open(session.Request{Action: "attach", ID: info.ID, Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		defer reopened.Close()
		if info.ID != again.ID || info.PID == nil || again.PID == nil || *info.PID != *again.PID {
			t.Fatal("attachment replaced the program")
		}
		// No restore record and no reboot: a missing ID is refused. Only a session
		// recorded in an earlier boot may be reopened (TC-PDTERM-154..156).
		if _, _, err := engine.Open(session.Request{Action: "attach", ID: "missing", Name: "native", Cols: 80, Rows: 24}); err == nil {
			t.Fatal("a missing ID silently created a shell")
		}
		if err := engine.Terminate(info.ID); err != nil {
			t.Fatal(err)
		}
		eventually(t, func() bool { return len(engine.List()) == 0 })
	})
	t.Run("[TC-PDTERM-022] viewers have independent geometry and cursor tracking", func(t *testing.T) {
		engine := session.NewEngine(factory)
		defer engine.Close()
		large, info, err := engine.Open(session.Request{Action: "create", Name: "sizes", Cols: 120, Rows: 40})
		if err != nil {
			t.Fatal(err)
		}
		defer large.Close()
		small, _, err := engine.Open(session.Request{Action: "attach", ID: info.ID, Cols: 40, Rows: 12})
		if err != nil {
			t.Fatal(err)
		}
		defer small.Close()
		if err := small.Apply(session.Request{Action: "refresh"}); err != nil {
			t.Fatal(err)
		}
		select {
		case reply := <-small.Frames():
			if reply.Screen == nil || reply.Screen.CanvasCols != 120 || reply.Screen.Cols != 40 {
				t.Fatalf("wrong shared geometry: %+v", reply.Screen)
			}
		case <-time.After(time.Second):
			t.Fatal("no viewport")
		}
		if err := small.Apply(session.Request{Action: "viewport", X: 60, Y: 10}); err != nil {
			t.Fatal(err)
		}
		select {
		case reply := <-small.Frames():
			if reply.Screen == nil || reply.Screen.X != 60 || reply.Screen.Y != 10 || reply.Screen.Follow {
				t.Fatalf("pan failed: %+v", reply.Screen)
			}
		case <-time.After(time.Second):
			t.Fatal("no viewport")
		}
		large.Close()
		if err := small.Apply(session.Request{Action: "refresh"}); err != nil {
			t.Fatal(err)
		}
		select {
		case reply := <-small.Frames():
			if reply.Screen == nil || reply.Screen.CanvasCols != 40 {
				t.Fatalf("remaining viewer did not set size: %+v", reply.Screen)
			}
		case <-time.After(time.Second):
			t.Fatal("no viewport")
		}
	})
}

func TestLocalIPC(t *testing.T) {
	t.Run("[TC-PDTERM-026] authenticated IPC detaches without killing the session", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		root := t.TempDir()
		finished := make(chan error, 1)
		go func() { finished <- session.Serve(ctx, root, "test", factory) }()
		client := &session.Client{Root: root}
		eventually(t, func() bool { _, err := client.Request(ctx, session.Request{Action: "ping"}); return err == nil })
		attachment, err := client.Attach(ctx, session.Request{Action: "create", Name: "ipc", Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		id := attachment.Info.ID
		attachment.Close()
		reply, err := client.Request(ctx, session.Request{Action: "list"})
		if err != nil || len(reply.Sessions) != 1 {
			t.Fatalf("list: %+v %v", reply, err)
		}
		if _, err := client.Request(ctx, session.Request{Action: "terminate", ID: id}); err != nil {
			t.Fatal(err)
		}
		cancel()
		select {
		case err := <-finished:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("engine did not stop")
		}
	})
}

func TestNativeRename(t *testing.T) {
	t.Run("[TC-PDUI-237] renaming preserves UUID PTY history viewers and attachment", func(t *testing.T) {
		engine := session.NewEngine(factory)
		defer engine.Close()
		view, original, err := engine.Open(session.Request{Action: "create", Name: "old", Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		defer view.Close()
		_ = view.Apply(session.Request{Action: "input", Data: "echo RENAME_PRESERVED\r"})
		eventually(t, func() bool {
			lines, _, _ := engine.History(original.ID)
			return strings.Contains(ansi.Strip(strings.Join(lines, "\n")), "RENAME_PRESERVED")
		})
		renamed, err := engine.Rename(original.ID, "new-name")
		if err != nil {
			t.Fatal(err)
		}
		if renamed.ID != original.ID || renamed.PID == nil || *renamed.PID != *original.PID || renamed.Attached != 1 {
			t.Fatalf("rename changed program: %+v", renamed)
		}
		lines, _, err := engine.History(original.ID)
		if err != nil || !strings.Contains(ansi.Strip(strings.Join(lines, "\n")), "RENAME_PRESERVED") {
			t.Fatal("rename lost history")
		}
		second, again, err := engine.Open(session.Request{Action: "attach", Name: "new-name", Cols: 40, Rows: 12})
		if err != nil {
			t.Fatal(err)
		}
		defer second.Close()
		if again.ID != original.ID || *again.PID != *original.PID {
			t.Fatal("new name replaced shell")
		}
		if _, _, err := engine.Open(session.Request{Action: "attach", Name: "old"}); err == nil {
			t.Fatal("old name still resolves")
		}
		other, otherInfo, err := engine.Open(session.Request{Action: "create", Name: "taken"})
		if err != nil {
			t.Fatal(err)
		}
		defer other.Close()
		for _, name := range []string{"taken", "", "bad name", strings.Repeat("x", 33), "x;kill-session"} {
			if _, err := engine.Rename(original.ID, name); err == nil {
				t.Fatalf("accepted invalid/duplicate name %q", name)
			}
		}
		if _, err := engine.Rename("missing", "new-name"); err == nil {
			t.Fatal("missing UUID renamed")
		}
		if _, err := engine.Rename(original.ID, "new-name"); err != nil {
			t.Fatal("same name is not idempotent", err)
		}
		if len(engine.List()) != 2 || engine.List()[1].ID != otherInfo.ID {
			t.Fatal("rename changed other sessions")
		}
		_ = second.Apply(session.Request{Action: "input", Data: "echo AFTER_RENAME\r"})
		eventually(t, func() bool {
			lines, _, _ := engine.History(original.ID)
			return strings.Contains(ansi.Strip(strings.Join(lines, "\n")), "AFTER_RENAME")
		})
	})
}
