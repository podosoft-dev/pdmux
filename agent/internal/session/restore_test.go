package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// restoreProcess is a PTY that ends only when told to, with the exit status the
// test chooses — the distinction restore depends on.
type restoreProcess struct {
	pid    int
	output chan []byte
	exit   chan *int
	once   sync.Once
}

func newRestoreProcess(pid int) *restoreProcess {
	return &restoreProcess{pid: pid, output: make(chan []byte, 16), exit: make(chan *int, 1)}
}

func (p *restoreProcess) Pid() *int             { return &p.pid }
func (p *restoreProcess) Write(string) error    { return nil }
func (p *restoreProcess) Resize(int, int) error { return nil }
func (p *restoreProcess) Output() <-chan []byte { return p.output }
func (p *restoreProcess) Exit() <-chan *int     { return p.exit }
func (p *restoreProcess) Kill()                 { p.end(nil) }
func (p *restoreProcess) end(code *int) {
	p.once.Do(func() { close(p.output); p.exit <- code })
}

// restoreSpawner records every spawn so a test can say how many shells started
// and where.
type restoreSpawner struct {
	mu          sync.Mutex
	directories []string
	processes   []*restoreProcess
	count       atomic.Int32
}

func (s *restoreSpawner) spawn(_ int, _ int, directory string) (Process, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	process := newRestoreProcess(1000 + len(s.processes))
	s.directories = append(s.directories, directory)
	s.processes = append(s.processes, process)
	s.count.Add(1)
	return process, nil
}

func (s *restoreSpawner) last() *restoreProcess {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.processes[len(s.processes)-1]
}

func restoreEngine(t *testing.T, root, boot string) (*Engine, *restoreSpawner) {
	t.Helper()
	spawner := &restoreSpawner{}
	engine := NewEngine(spawner.spawn)
	engine.EnableRestore(root, boot, nil)
	t.Cleanup(engine.Close)
	return engine, spawner
}

func readRestore(t *testing.T, root string) restoreDocument {
	t.Helper()
	var document restoreDocument
	bytes, err := os.ReadFile(filepath.Join(root, RestoreFile))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(bytes, &document); err != nil {
		t.Fatal(err)
	}
	return document
}

func waitRestore(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("restore condition did not become true")
}

// liveSession creates a session in a first boot and leaves it running, as a
// reboot would find it.
func liveSession(t *testing.T, root, boot, name, directory string) Info {
	t.Helper()
	engine, _ := restoreEngine(t, root, boot)
	view, info, err := engine.Open(Request{Action: "create", Name: name, Directory: directory, Cols: 100, Rows: 30})
	if err != nil {
		t.Fatal(err)
	}
	view.Close()
	return info
}

func TestNativeRebootRestore(t *testing.T) {
	t.Run("[TC-PDTERM-154] a UUID recorded in an earlier boot reopens under the same UUID, name and directory", func(t *testing.T) {
		root, directory := t.TempDir(), t.TempDir()
		before := liveSession(t, root, "boot-aaaa", "w2", directory)
		// A new helper after the restart: same state directory, different boot.
		engine, spawner := restoreEngine(t, root, "boot-bbbb")
		view, info, err := engine.Open(Request{Action: "attach", ID: before.ID, Cols: 80, Rows: 24})
		if err != nil {
			t.Fatalf("restorable session was refused: %v", err)
		}
		defer view.Close()
		if info.ID != before.ID || info.Name != "w2" || info.Restored != RestoredReboot {
			t.Fatalf("restored identity = %+v", info)
		}
		if got := spawner.directories; len(got) != 1 || got[0] != directory {
			t.Fatalf("restored shell started in %v, want %s", got, directory)
		}
		entries := readRestore(t, root).Entries
		if len(entries) != 1 || entries[0].UUID != before.ID || entries[0].BootID != "boot-bbbb" {
			t.Fatalf("the reopened session must be recorded under the new boot: %+v", entries)
		}
	})

	t.Run("[TC-PDTERM-154] concurrent attaches to one restorable UUID start one shell", func(t *testing.T) {
		root := t.TempDir()
		before := liveSession(t, root, "boot-aaaa", "shared", "")
		engine, spawner := restoreEngine(t, root, "boot-bbbb")
		var wg sync.WaitGroup
		infos := make([]Info, 6)
		errs := make([]error, 6)
		for i := range infos {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				view, info, err := engine.Open(Request{Action: "attach", ID: before.ID, Cols: 80, Rows: 24})
				infos[i], errs[i] = info, err
				if view != nil {
					t.Cleanup(view.Close)
				}
			}(i)
		}
		wg.Wait()
		for i := range infos {
			if errs[i] != nil || infos[i].ID != before.ID || infos[i].Restored != RestoredReboot {
				t.Fatalf("viewer %d: %+v %v", i, infos[i], errs[i])
			}
		}
		if spawner.count.Load() != 1 || len(engine.List()) != 1 {
			t.Fatalf("spawned %d shells for one UUID", spawner.count.Load())
		}
	})

	t.Run("[TC-PDTERM-155] within the same boot a missing UUID is still refused", func(t *testing.T) {
		root := t.TempDir()
		engine, spawner := restoreEngine(t, root, "boot-aaaa")
		view, info, err := engine.Open(Request{Action: "create", Name: "w1"})
		if err != nil {
			t.Fatal(err)
		}
		view.Close()
		// The helper failed and was restarted without a reboot: the shell is gone
		// and its record must not bring it back.
		spawner.last().Kill()
		waitRestore(t, func() bool { return len(engine.List()) == 0 })
		again, againSpawner := restoreEngine(t, root, "boot-aaaa")
		if _, _, err := again.Open(Request{Action: "attach", ID: info.ID}); err == nil || err.Error() != "SESSION_NOT_FOUND" {
			t.Fatalf("same-boot attach = %v, want SESSION_NOT_FOUND", err)
		}
		if againSpawner.count.Load() != 0 {
			t.Fatal("a same-boot attach started a shell")
		}
	})

	t.Run("[TC-PDTERM-155] a helper restarted in the same boot drops that boot's entries", func(t *testing.T) {
		root := t.TempDir()
		before := liveSession(t, root, "boot-aaaa", "w1", "")
		restoreEngine(t, root, "boot-aaaa")
		if entries := readRestore(t, root).Entries; len(entries) != 0 {
			t.Fatalf("same-boot entries survived a helper restart: %+v", entries)
		}
		later, spawner := restoreEngine(t, root, "boot-cccc")
		if _, _, err := later.Open(Request{Action: "attach", ID: before.ID}); err == nil || spawner.count.Load() != 0 {
			t.Fatal("a session that ended before the reboot came back after it")
		}
	})

	t.Run("[TC-PDTERM-156] a shell that exited, or was terminated, is not restored", func(t *testing.T) {
		root := t.TempDir()
		engine, spawner := restoreEngine(t, root, "boot-aaaa")
		_, exited, err := engine.Open(Request{Action: "create", Name: "exited"})
		if err != nil {
			t.Fatal(err)
		}
		zero := 0
		spawner.last().end(&zero)
		_, terminated, err := engine.Open(Request{Action: "create", Name: "terminated"})
		if err != nil {
			t.Fatal(err)
		}
		if err := engine.Terminate(terminated.ID); err != nil {
			t.Fatal(err)
		}
		waitRestore(t, func() bool { return len(engine.List()) == 0 })
		if entries := readRestore(t, root).Entries; len(entries) != 0 {
			t.Fatalf("ended sessions kept restore entries: %+v", entries)
		}
		after, afterSpawner := restoreEngine(t, root, "boot-bbbb")
		for _, id := range []string{exited.ID, terminated.ID} {
			if _, _, err := after.Open(Request{Action: "attach", ID: id}); err == nil {
				t.Fatalf("ended session %s was restored", id)
			}
		}
		if afterSpawner.count.Load() != 0 {
			t.Fatal("an ended session started a shell after the reboot")
		}
	})

	t.Run("[TC-PDTERM-156] shells ended by the helper's own shutdown keep their entries", func(t *testing.T) {
		root := t.TempDir()
		spawner := &restoreSpawner{}
		engine := NewEngine(spawner.spawn)
		engine.EnableRestore(root, "boot-aaaa", nil)
		_, info, err := engine.Open(Request{Action: "create", Name: "kept"})
		if err != nil {
			t.Fatal(err)
		}
		engine.MarkClosing()
		engine.Close()
		waitRestore(t, func() bool { return len(engine.List()) == 0 })
		entries := readRestore(t, root).Entries
		if len(entries) != 1 || entries[0].UUID != info.ID {
			t.Fatalf("shutdown dropped the entry a reboot needs: %+v", entries)
		}
	})

	t.Run("[TC-PDTERM-157] the record is owner-only, replaced atomically, and survives garbage", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("POSIX permission bits")
		}
		root := t.TempDir()
		liveSession(t, root, "boot-aaaa", "w1", "")
		info, err := os.Stat(filepath.Join(root, RestoreFile))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("restore.json mode = %v, want 0600", info.Mode().Perm())
		}
		names, _ := filepath.Glob(filepath.Join(root, ".restore-*"))
		if len(names) != 0 {
			t.Fatalf("temporary files left behind: %v", names)
		}
		if err := os.WriteFile(filepath.Join(root, RestoreFile), []byte("{not json"), 0o600); err != nil {
			t.Fatal(err)
		}
		engine, _ := restoreEngine(t, root, "boot-bbbb")
		if _, _, err := engine.Open(Request{Action: "create", Name: "fresh"}); err != nil {
			t.Fatalf("a corrupt record broke session creation: %v", err)
		}
		if entries := readRestore(t, root).Entries; len(entries) != 1 || entries[0].Name != "fresh" {
			t.Fatalf("corrupt record was not replaced: %+v", entries)
		}
	})

	t.Run("[TC-PDTERM-157] without a boot identity nothing is recorded or restored", func(t *testing.T) {
		root := t.TempDir()
		engine, _ := restoreEngine(t, root, "")
		if _, _, err := engine.Open(Request{Action: "create", Name: "w1"}); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(filepath.Join(root, RestoreFile)); !os.IsNotExist(err) {
			t.Fatalf("restore.json written without a boot identity: %v", err)
		}
	})

	t.Run("[TC-PDTERM-158] a vanished directory falls back to home and a taken name gets a suffix", func(t *testing.T) {
		root, directory := t.TempDir(), filepath.Join(t.TempDir(), "gone")
		if err := os.Mkdir(directory, 0o700); err != nil {
			t.Fatal(err)
		}
		before := liveSession(t, root, "boot-aaaa", "w3", directory)
		if err := os.Remove(directory); err != nil {
			t.Fatal(err)
		}
		engine, spawner := restoreEngine(t, root, "boot-bbbb")
		if _, _, err := engine.Open(Request{Action: "create", Name: "w3"}); err != nil {
			t.Fatal(err)
		}
		_, info, err := engine.Open(Request{Action: "attach", ID: before.ID})
		if err != nil {
			t.Fatal(err)
		}
		if info.ID != before.ID || info.Name != "w3-2" {
			t.Fatalf("restored beside a live namesake as %+v", info)
		}
		if got := spawner.directories[len(spawner.directories)-1]; got != "" {
			t.Fatalf("restored into a missing directory %q instead of home", got)
		}
	})

	t.Run("[TC-PDTERM-158] a rename is what the next boot restores", func(t *testing.T) {
		root := t.TempDir()
		engine, _ := restoreEngine(t, root, "boot-aaaa")
		_, info, err := engine.Open(Request{Action: "create", Name: "before"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := engine.Rename(info.ID, "after"); err != nil {
			t.Fatal(err)
		}
		next, _ := restoreEngine(t, root, "boot-bbbb")
		_, restored, err := next.Open(Request{Action: "attach", ID: info.ID})
		if err != nil || restored.Name != "after" {
			t.Fatalf("restored as %+v %v", restored, err)
		}
	})

	t.Run("[TC-PDTERM-159] a Linux shell's current directory is refreshed into the record", func(t *testing.T) {
		if runtime.GOOS != "linux" {
			t.Skip("/proc/<pid>/cwd is Linux-only; other platforms keep the spawn directory")
		}
		working, _ := os.Getwd()
		pid := os.Getpid()
		if got := processDirectory(&pid); got != working {
			t.Fatalf("processDirectory = %q, want %q", got, working)
		}
	})

	t.Run("[TC-PDTERM-159] the spawn directory stays when the platform cannot say", func(t *testing.T) {
		root, directory := t.TempDir(), t.TempDir()
		engine, _ := restoreEngine(t, root, "boot-aaaa")
		if _, _, err := engine.Open(Request{Action: "create", Name: "w1", Directory: directory}); err != nil {
			t.Fatal(err)
		}
		// The fake process's pid is not a real process here, so nothing can be
		// read; the refresh must keep the directory it already had.
		engine.RefreshRestore()
		entries := readRestore(t, root).Entries
		if len(entries) != 1 || entries[0].Cwd != directory {
			t.Fatalf("refresh lost the directory: %+v", entries)
		}
	})

	t.Run("[TC-PDTERM-160] an ensure made for a vanished tmux session starts where a namesake was", func(t *testing.T) {
		root, directory := t.TempDir(), t.TempDir()
		liveSession(t, root, "boot-aaaa", "claude-1", directory)
		engine, spawner := restoreEngine(t, root, "boot-bbbb")
		_, info, err := engine.Open(Request{Action: "ensure", Name: "claude-1", Restore: true})
		if err != nil {
			t.Fatal(err)
		}
		if info.Name != "claude-1" || spawner.directories[0] != directory {
			t.Fatalf("ensure-restore = %+v in %v", info, spawner.directories)
		}
		// A plain ensure — the person opening a session by name — never borrows
		// an earlier boot's directory.
		plainRoot := t.TempDir()
		liveSession(t, plainRoot, "boot-aaaa", "w9", directory)
		plain, plainSpawner := restoreEngine(t, plainRoot, "boot-bbbb")
		_, plainInfo, err := plain.Open(Request{Action: "ensure", Name: "w9"})
		if err != nil || plainSpawner.directories[0] != "" || plainInfo.Restored != "" {
			t.Fatalf("plain ensure borrowed the record: %+v %v %v", plainInfo, plainSpawner.directories, err)
		}
	})

	t.Run("[TC-PDTERM-157] the record keeps only the newest entries", func(t *testing.T) {
		root := t.TempDir()
		store := openRestoreStore(root, "boot-aaaa", nil)
		for i := 0; i < maxRestoreEntries+5; i++ {
			store.record(RestoreEntry{UUID: strings.Replace("00000000-0000-4000-8000-0000000000xx", "xx", twoDigits(i), 1), Name: "w1"})
		}
		if entries := readRestore(t, root).Entries; len(entries) != maxRestoreEntries {
			t.Fatalf("record holds %d entries, want %d", len(entries), maxRestoreEntries)
		}
	})
}

func twoDigits(i int) string {
	const digits = "0123456789"
	return string([]byte{digits[i/10%10], digits[i%10]})
}
