package session

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"sync"
	"time"
)

// RestoreFile records the native sessions that were alive, so that after the
// machine restarts a pane asking for one of them can be given a fresh shell under
// the same identity instead of an error.
//
// ⚠ THIS IS NOT CHECKPOINTING. Nothing about the programs is kept — only the
// session's UUID, name, working directory and size. What comes back after a reboot
// is a new shell in the same place, and the browser says so in words (the ready
// frame carries `restored`). A pane never silently gets a different program.
//
// ⚠ IT IS DELIBERATELY NOT TIED TO THE HELPER'S SECRET. session-names.json is
// discarded when a new helper starts, because its job ends with the helper. This
// file's job starts exactly then: the reboot that killed the helper is what makes
// its entries useful.
const RestoreFile = "restore.json"

const (
	// maxRestoreEntries bounds the file. Twice MaxSessions leaves room for one
	// boot's sessions to wait for their panes while the next boot creates its own.
	maxRestoreEntries = 2 * MaxSessions
	// restoreMaxAge drops entries nobody came back for. A month-old shell is not
	// something a person expects to reappear.
	restoreMaxAge = 30 * 24 * time.Hour
	// maxRestoreFileBytes refuses a file that grew past anything this code writes.
	maxRestoreFileBytes = 64 << 10
	// restoredNoticeWindow is how long after a restore an attaching viewer is
	// still told the session was reopened. Every pane of a layout reattaches
	// within seconds of the agent coming back; a pane opened much later is opening
	// a session that has simply been running since.
	restoredNoticeWindow = 2 * time.Minute
)

// RestoredReboot is the only restore reason: the machine restarted.
const RestoredReboot = "reboot"

// RestoreEntry is one session that may be reopened after a reboot.
type RestoreEntry struct {
	UUID      string `json:"uuid"`
	Name      string `json:"name"`
	Cwd       string `json:"cwd"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
	BootID    string `json:"bootId"`
	UpdatedAt int64  `json:"updatedAt"`
}

type restoreDocument struct {
	Version int            `json:"version"`
	Entries []RestoreEntry `json:"entries"`
}

type restoreStore struct {
	mu      sync.Mutex
	path    string
	bootID  string
	now     func() time.Time
	entries map[string]RestoreEntry
}

var restoreUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// openRestoreStore loads root/restore.json for the boot bootID.
//
// An empty bootID returns nil: without a boot identity a reboot cannot be told
// apart from a helper that merely restarted, and restore stays off.
//
// Entries recorded during the CURRENT boot are dropped on load. A helper that
// starts while the machine has not restarted means the previous helper failed,
// and its sessions ended in this boot — restoring them later, after an unrelated
// reboot, would bring back shells nobody had open.
func openRestoreStore(root, bootID string, now func() time.Time) *restoreStore {
	if bootID == "" {
		return nil
	}
	if now == nil {
		now = time.Now
	}
	store := &restoreStore{path: filepath.Join(root, RestoreFile), bootID: bootID, now: now, entries: make(map[string]RestoreEntry)}
	changed := false
	if bytes, err := os.ReadFile(store.path); err == nil {
		var document restoreDocument
		if len(bytes) > maxRestoreFileBytes || json.Unmarshal(bytes, &document) != nil {
			changed = true
		} else {
			cutoff := now().Add(-restoreMaxAge).Unix()
			for _, entry := range document.Entries {
				if !restoreUUID.MatchString(entry.UUID) || !validName.MatchString(entry.Name) || entry.BootID == "" || entry.BootID == bootID || entry.UpdatedAt < cutoff {
					changed = true
					continue
				}
				store.entries[entry.UUID] = entry
			}
		}
	}
	if store.trim() || changed {
		_ = store.saveLocked()
	}
	return store
}

// trim keeps the newest maxRestoreEntries entries.
func (r *restoreStore) trim() bool {
	if len(r.entries) <= maxRestoreEntries {
		return false
	}
	list := r.sorted()
	for _, entry := range list[maxRestoreEntries:] {
		delete(r.entries, entry.UUID)
	}
	return true
}

func (r *restoreStore) sorted() []RestoreEntry {
	list := make([]RestoreEntry, 0, len(r.entries))
	for _, entry := range r.entries {
		list = append(list, entry)
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].UpdatedAt != list[j].UpdatedAt {
			return list[i].UpdatedAt > list[j].UpdatedAt
		}
		return list[i].UUID < list[j].UUID
	})
	return list
}

// record writes or replaces a live session's entry under the current boot.
func (r *restoreStore) record(entry RestoreEntry) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	entry.BootID = r.bootID
	entry.UpdatedAt = r.now().Unix()
	r.entries[entry.UUID] = entry
	r.trim()
	_ = r.saveLocked()
}

// update changes a live session's entry and saves only when something changed.
func (r *restoreStore) update(uuid string, change func(*RestoreEntry)) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.entries[uuid]
	if !ok || entry.BootID != r.bootID {
		return
	}
	before := entry
	change(&entry)
	if entry == before {
		return
	}
	entry.UpdatedAt = r.now().Unix()
	r.entries[uuid] = entry
	_ = r.saveLocked()
}

// forget removes an entry: the session ended in a way that must not come back.
func (r *restoreStore) forget(uuid string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.entries[uuid]; !ok {
		return
	}
	delete(r.entries, uuid)
	_ = r.saveLocked()
}

// restorable returns the entry for uuid when it was recorded in an EARLIER boot.
func (r *restoreStore) restorable(uuid string) (RestoreEntry, bool) {
	if r == nil {
		return RestoreEntry{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.entries[uuid]
	if !ok || entry.BootID == "" || entry.BootID == r.bootID {
		return RestoreEntry{}, false
	}
	return entry, true
}

// restorableByName is restorable for the newest earlier-boot entry with name.
func (r *restoreStore) restorableByName(name string) (RestoreEntry, bool) {
	if r == nil {
		return RestoreEntry{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, entry := range r.sorted() {
		if entry.Name == name && entry.BootID != r.bootID {
			return entry, true
		}
	}
	return RestoreEntry{}, false
}

// saveLocked writes the file atomically: a temporary file in the same directory,
// owner-only, synced, then renamed over the old one. A crash mid-write leaves the
// previous file, never half of a new one.
func (r *restoreStore) saveLocked() error {
	document := restoreDocument{Version: 1, Entries: r.sorted()}
	file, err := os.CreateTemp(filepath.Dir(r.path), ".restore-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err := secureFile(file.Name()); err != nil {
		return err
	}
	if err := json.NewEncoder(file).Encode(document); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), r.path)
}

// restoreDirectory is where a restored shell starts: the recorded directory when
// it still exists, otherwise the spawner's default (the user's home).
func restoreDirectory(cwd string) string {
	if cwd == "" || !filepath.IsAbs(cwd) {
		return ""
	}
	if info, err := os.Stat(cwd); err != nil || !info.IsDir() {
		return ""
	}
	return cwd
}

// processDirectory is a running shell's current directory where the platform
// exposes it cheaply. Linux reads /proc/<pid>/cwd; elsewhere the spawn directory
// stays in the record.
func processDirectory(pid *int) string {
	if pid == nil || runtime.GOOS != "linux" {
		return ""
	}
	target, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(*pid), "cwd"))
	if err != nil || !filepath.IsAbs(target) {
		return ""
	}
	return target
}

// freeName returns name, or name-2, name-3 … when a live session already holds it.
func freeName(name string, taken func(string) bool) string {
	if !taken(name) {
		return name
	}
	for i := 2; i < 100; i++ {
		suffix := fmt.Sprintf("-%d", i)
		base := name
		if len(base)+len(suffix) > 32 {
			base = base[:32-len(suffix)]
		}
		if candidate := base + suffix; !taken(candidate) {
			return candidate
		}
	}
	return name
}
