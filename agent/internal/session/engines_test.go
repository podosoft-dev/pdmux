package session

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"
)

// Engines side by side: an update that finds an older engine still running
// programs leaves it be and starts the new sessions in a newer engine beside it.
// The native CI matrix selects TestNative* on all three operating systems.

// engineRig serves engines in this process, as `session serve` would, so a
// test can start, stop and inspect them.
type engineRig struct {
	t       *testing.T
	version string
	pids    atomic.Int32
	mu      sync.Mutex
	stops   map[string]func()
}

func newEngineRig(t *testing.T, version string) *engineRig {
	r := &engineRig{t: t, version: version, stops: make(map[string]func())}
	t.Cleanup(r.stopAll)
	return r
}

func (r *engineRig) factory(int, int, string) (Process, error) {
	return &namedTestProcess{pid: int(r.pids.Add(1)) + 1000, output: make(chan []byte, 32), exited: make(chan *int, 1)}, nil
}

func (r *engineRig) serve(dir string) {
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	go func() { finished <- Serve(ctx, dir, r.version, r.factory) }()
	r.mu.Lock()
	r.stops[dir] = func() {
		cancel()
		select {
		case <-finished:
		case <-time.After(3 * time.Second):
			r.t.Errorf("engine in %s did not stop", dir)
		}
	}
	r.mu.Unlock()
}

func (r *engineRig) start(_ context.Context, dir string) error {
	r.serve(dir)
	return nil
}

func (r *engineRig) stop(dir string) {
	r.mu.Lock()
	stop := r.stops[dir]
	delete(r.stops, dir)
	r.mu.Unlock()
	if stop != nil {
		stop()
	}
}

func (r *engineRig) stopAll() {
	r.mu.Lock()
	dirs := make([]string, 0, len(r.stops))
	for dir := range r.stops {
		dirs = append(dirs, dir)
	}
	r.mu.Unlock()
	for _, dir := range dirs {
		r.stop(dir)
	}
}

func waitServing(t *testing.T, c *Client, dir string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := c.requestAt(context.Background(), dir, Request{Action: "ping"}); err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("no engine in %s", dir)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func eventuallyTrue(t *testing.T, label string, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out: %s", label)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func sessionNamesOf(reply Reply) []string {
	var names []string
	for _, info := range reply.Sessions {
		names = append(names, info.Name)
	}
	return names
}

// busyOldEngine serves version 0.1.0 in a fresh Root with one running session.
func busyOldEngine(t *testing.T) (string, *engineRig, *Attachment) {
	t.Helper()
	root := t.TempDir()
	old := newEngineRig(t, "0.1.0")
	old.serve(root)
	oldClient := &Client{Root: root, Version: "0.1.0"}
	waitServing(t, oldClient, root)
	kept, err := oldClient.Attach(context.Background(), Request{Action: "create", Name: "kept", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(kept.Close)
	return root, old, kept
}

func TestNativeEnginesSideBySide(t *testing.T) {
	ctx := context.Background()
	t.Run("[TC-PDTERM-191] a busy older engine keeps its programs and a new session starts in a newer engine", func(t *testing.T) {
		root, _, kept := busyOldEngine(t)
		current := newEngineRig(t, "0.1.40")
		client := &Client{Root: root, Version: "0.1.40", start: current.start}
		fresh, err := client.Attach(ctx, Request{Action: "create", Name: "fresh", Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		defer fresh.Close()
		if fresh.Version != "0.1.40" || kept.Version != "0.1.0" {
			t.Fatalf("fresh session on %s, kept on %s", fresh.Version, kept.Version)
		}
		dirs := engineDirs(root)
		if len(dirs) != 2 || engineBase(dirs[1]) != root {
			t.Fatalf("engine directories %v", dirs)
		}
		list, err := client.Request(ctx, Request{Action: "list"})
		if err != nil || strings.Join(sessionNamesOf(list), ",") != "fresh,kept" || list.Version != "0.1.40" {
			t.Fatalf("list %+v %v", list, err)
		}
		ping, err := client.Request(ctx, Request{Action: "ping"})
		if err != nil || ping.Version != "0.1.40" {
			t.Fatalf("ping %+v %v", ping, err)
		}
		// A name the older engine has still means its program.
		again, err := client.Attach(ctx, Request{Action: "ensure", Name: "kept", Cols: 80, Rows: 24})
		if err != nil || again.Info.ID != kept.Info.ID || again.Version != "0.1.0" {
			t.Fatalf("ensure kept: %+v %v", again, err)
		}
		again.Close()
		if _, err := client.Attach(ctx, Request{Action: "create", Name: "kept", Cols: 80, Rows: 24}); err == nil || err.Error() != "SESSION_EXISTS" {
			t.Fatalf("a second kept: %v", err)
		}
		byID, err := client.Attach(ctx, Request{Action: "attach", ID: kept.Info.ID, Cols: 80, Rows: 24})
		if err != nil || byID.Version != "0.1.0" {
			t.Fatalf("attach by ID: %v", err)
		}
		byID.Close()
		// Names stay unique across engines.
		if _, err := client.Request(ctx, Request{Action: "rename", ID: fresh.Info.ID, Name: "kept"}); err == nil || err.Error() != "SESSION_EXISTS" {
			t.Fatalf("rename onto the other engine's name: %v", err)
		}
		if renamed, err := client.Request(ctx, Request{Action: "rename", ID: kept.Info.ID, Name: "older"}); err != nil || renamed.Info == nil || renamed.Info.Name != "older" {
			t.Fatalf("rename in the older engine: %+v %v", renamed, err)
		}
		// Each request reaches the engine that runs the session.
		_ = kept.Send(Request{Action: "input", Data: "OLD_MARK"})
		_ = fresh.Send(Request{Action: "input", Data: "NEW_MARK"})
		for id, marker := range map[string]string{kept.Info.ID: "OLD_MARK", fresh.Info.ID: "NEW_MARK"} {
			eventuallyTrue(t, marker, func() bool {
				reply, err := client.Request(ctx, Request{Action: "history", ID: id})
				return err == nil && strings.Contains(ansi.Strip(strings.Join(reply.Lines, "\n")), marker)
			})
		}
		if _, err := client.Request(ctx, Request{Action: "terminate", ID: kept.Info.ID}); err != nil {
			t.Fatal(err)
		}
		eventuallyTrue(t, "older session gone", func() bool {
			list, err := client.Request(ctx, Request{Action: "list"})
			return err == nil && strings.Join(sessionNamesOf(list), ",") == "fresh"
		})
		// Idle now, the older engine stops at the next ensure; the newer one stays.
		if dir, err := client.ensure(ctx); err != nil || dir != dirs[1] {
			t.Fatalf("ensure after the older engine emptied: %q %v", dir, err)
		}
		if _, err := client.requestAt(ctx, root, Request{Action: "ping"}); err == nil {
			t.Fatal("the idle older engine still serves")
		}
	})
	t.Run("[TC-PDTERM-192] an idle older engine is replaced in Root, and Root is used again once it is free", func(t *testing.T) {
		root := t.TempDir()
		old := newEngineRig(t, "0.1.0")
		old.serve(root)
		current := newEngineRig(t, "0.1.40")
		client := &Client{Root: root, Version: "0.1.40", start: current.start}
		waitServing(t, client, root)
		dir, err := client.ensure(ctx)
		if err != nil || dir != root || len(engineDirs(root)) != 1 {
			t.Fatalf("ensure %q %v, dirs %v", dir, err, engineDirs(root))
		}
		if ping, _ := client.Request(ctx, Request{Action: "ping"}); ping.Version != "0.1.40" {
			t.Fatalf("Root serves %s", ping.Version)
		}
		// From a slot back to Root: the older engine and the slot both stop.
		root2, old2, kept := busyOldEngine(t)
		client2 := &Client{Root: root2, Version: "0.1.40", start: current.start}
		slot, err := client2.ensure(ctx)
		if err != nil || slot == root2 {
			t.Fatalf("slot %q %v", slot, err)
		}
		kept.Close()
		old2.stop(root2)
		current.stop(slot)
		dir, err = client2.ensure(ctx)
		if err != nil || dir != root2 {
			t.Fatalf("ensure after both stopped: %q %v", dir, err)
		}
		if dirs := engineDirs(root2); len(dirs) != 1 {
			t.Fatalf("stopped slot left behind: %v", dirs)
		}
	})
	t.Run("[TC-PDTERM-192] an engine is never started from a test binary", func(t *testing.T) {
		client := &Client{Root: t.TempDir(), Version: "0.1.40"}
		if err := client.Ensure(ctx); err == nil || err.Error() != "SESSION_ENGINE_EXECUTABLE_INVALID" {
			t.Fatalf("ensure from a test binary: %v", err)
		}
	})
	t.Run("[TC-PDTERM-193] concurrent clients start one newer engine and one session per name", func(t *testing.T) {
		root, _, _ := busyOldEngine(t)
		current := newEngineRig(t, "0.1.40")
		type result struct {
			id  string
			err error
		}
		results := make(chan result, 4)
		var attachments sync.WaitGroup
		for range 4 {
			attachments.Go(func() {
				client := &Client{Root: root, Version: "0.1.40", start: current.start}
				a, err := client.Attach(ctx, Request{Action: "ensure", Name: "shared", Cols: 80, Rows: 24})
				if err != nil {
					results <- result{err: err}
					return
				}
				defer a.Close()
				results <- result{id: a.Info.ID}
			})
		}
		attachments.Wait()
		close(results)
		ids := map[string]bool{}
		for r := range results {
			if r.err != nil {
				t.Fatal(r.err)
			}
			ids[r.id] = true
		}
		if len(ids) != 1 || len(engineDirs(root)) != 2 {
			t.Fatalf("sessions %v, engine directories %v", ids, engineDirs(root))
		}
	})
}

func TestNativeRetiredEngineRestore(t *testing.T) {
	t.Run("[TC-PDTERM-194] after a restart a stopped slot's sessions reopen and the slot is removed", func(t *testing.T) {
		root := t.TempDir()
		slot := filepath.Join(root, slotsDirectory, "0123456789abcdef01234567")
		running := filepath.Join(root, slotsDirectory, "fedcba9876543210fedcba98")
		for _, dir := range []string{slot, running} {
			if err := secureDirectory(dir); err != nil {
				t.Fatal(err)
			}
		}
		now := time.Now().Unix()
		retired, rooted := randomID(), randomID()
		workdir := t.TempDir()
		if err := writeRestore(filepath.Join(slot, RestoreFile), []RestoreEntry{{UUID: retired, Name: "retired", Cwd: workdir, Cols: 80, Rows: 24, BootID: "boot-1", UpdatedAt: now}}); err != nil {
			t.Fatal(err)
		}
		if err := writeRestore(filepath.Join(root, RestoreFile), []RestoreEntry{
			{UUID: retired, Name: "stale", Cwd: workdir, Cols: 80, Rows: 24, BootID: "boot-1", UpdatedAt: now - 100},
			{UUID: rooted, Name: "rooted", Cwd: workdir, Cols: 80, Rows: 24, BootID: "boot-1", UpdatedAt: now - 50},
		}); err != nil {
			t.Fatal(err)
		}
		// A slot whose engine still serves keeps its directory.
		unlock, err := lockEngine(running)
		if err != nil {
			t.Fatal(err)
		}
		defer unlock()
		adoptRetired(root, "boot-2")
		if _, err := os.Stat(slot); !os.IsNotExist(err) {
			t.Fatalf("stopped slot kept: %v", err)
		}
		if _, err := os.Stat(running); err != nil {
			t.Fatalf("running slot removed: %v", err)
		}
		rig := newEngineRig(t, "0.1.40")
		engine := NewEngine(rig.factory)
		defer engine.Close()
		engine.EnableRestore(root, "boot-2", nil)
		for uuid, name := range map[string]string{retired: "retired", rooted: "rooted"} {
			view, info, err := engine.Open(Request{Action: "attach", ID: uuid, Cols: 80, Rows: 24})
			if err != nil || info.ID != uuid || info.Name != name || info.Restored != RestoredReboot {
				t.Fatalf("restore %s: %+v %v", name, info, err)
			}
			view.Close()
		}
	})
	t.Run("[TC-PDTERM-194] a restart within the same boot adopts nothing that is still running", func(t *testing.T) {
		root, _, kept := busyOldEngine(t)
		current := newEngineRig(t, "0.1.40")
		client := &Client{Root: root, Version: "0.1.40", start: current.start}
		fresh, err := client.Attach(context.Background(), Request{Action: "create", Name: "fresh", Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		defer fresh.Close()
		// The older engine in Root still runs kept: the slot engine's start left
		// Root's record alone and only Root's engine reopens kept's UUID.
		for _, entry := range restoreEntriesAt(filepath.Join(engineDirs(root)[1], RestoreFile)) {
			if entry.UUID == kept.Info.ID {
				t.Fatal("the slot adopted a session Root still runs")
			}
		}
	})
}
