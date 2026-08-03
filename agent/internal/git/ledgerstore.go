package git

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"

	"github.com/podosoft-dev/pdmux/agent/internal/state"
)

// LedgerVersion is the on-disk layout number. A file written by any other
// version is discarded rather than guessed at.
const LedgerVersion = 1

// Repos maps a repository path to the shas the server has acknowledged.
type Repos map[string][]string

// Store is the on-disk half of the commit-detail ledger.
//
// WHY ON DISK AT ALL: commit patches are immutable, so the only reason to
// produce one twice is that nobody remembered. Before the server acked what it
// stored, a restarted agent spent its whole per-pass budget rebuilding patches
// the server already had — on a 300-commit window that is minutes of `git show`
// per repo for nothing.
//
// WHAT IS STORED: only shas the SERVER acknowledged (`detailAck`). Anything the
// agent merely sent is memory-only, because a frame in flight when the socket
// dropped may never have been stored, and silently skipping it would leave a
// commit permanently blank.
type Store interface {
	Load(hostID string) Repos
	Save(hostID string, repos Repos) error
	// Unavailable is true once writing has failed — surfaced to the operator as
	// the `state.unwritable` diagnostic.
	Unavailable() bool
}

type ledgerDocument struct {
	V      *int                       `json:"v"`
	HostID *string                    `json:"hostId"`
	Repos  map[string]json.RawMessage `json:"repos"`
}

// ParseLedger reads a ledger file, keeping only what is unambiguously ours.
func ParseLedger(text []byte, hostID string) Repos {
	out := Repos{}
	var document ledgerDocument
	// Anything that is not a JSON object — `null`, a number, an array, a
	// truncated write — fails here and is treated as "no ledger".
	if err := json.Unmarshal(text, &document); err != nil {
		return out
	}
	// A ledger written by a newer/older layout, or by another host's agent, is
	// discarded rather than guessed at: the cost of rebuilding is bounded, the
	// cost of a wrong skip is a blank commit forever.
	if document.V == nil || *document.V != LedgerVersion {
		return out
	}
	if document.HostID == nil || *document.HostID != hostID {
		return out
	}
	for path, raw := range document.Repos {
		var entries []any
		if err := json.Unmarshal(raw, &entries); err != nil {
			continue // not an array: skip this repository, keep the rest
		}
		shas := []string{}
		for _, entry := range entries {
			if sha, ok := entry.(string); ok {
				shas = append(shas, sha)
			}
		}
		out[path] = shas
	}
	return out
}

var unsafeInFileName = regexp.MustCompile(`[^A-Za-z0-9-]`)

// LedgerFileName is the per-host ledger file.
//
// One file per host, because the ledger names repository paths on this machine
// and mixing two servers' memories is how a detail gets skipped for a server
// that never had it. The host id comes from the server, so the name is reduced
// to characters that cannot escape the state directory even if that id is ever
// less strict.
func LedgerFileName(hostID string) string {
	return "details-" + unsafeInFileName.ReplaceAllString(hostID, "_") + ".json"
}

// FileStore keeps the ledger in the agent's state directory, 0600 inside 0700.
type FileStore struct {
	mu  sync.Mutex
	dir string
	// disabled is set after the first failed write. A state directory that cannot
	// be created (read-only root, wrong unit) will not become writable later in
	// this process, and retrying on every ack would turn one misconfiguration
	// into a syscall per acknowledgement forever.
	disabled bool
}

// NewFileStore returns a store rooted at the resolved state directory.
func NewFileStore(dir string) *FileStore {
	return &FileStore{dir: dir}
}

func (s *FileStore) path(hostID string) string {
	return filepath.Join(s.dir, LedgerFileName(hostID))
}

// Unavailable reports the condition behind the `state.unwritable` diagnostic.
func (s *FileStore) Unavailable() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.disabled
}

// Load reads this host's ledger. No ledger yet is the normal first run, and an
// unreadable one is treated the same way: rebuild rather than guess.
func (s *FileStore) Load(hostID string) Repos {
	data, err := os.ReadFile(s.path(hostID))
	if err != nil {
		return Repos{}
	}
	return ParseLedger(data, hostID)
}

// Save writes the ledger atomically, 0600 inside a 0700 directory.
//
// The mode and the write-then-rename both come from state.WriteFilePrivate: the
// ledger names repository paths on this machine, which is not something to leave
// world-readable, and a crash mid-write must leave the previous ledger rather
// than a truncated file that parses as "I have nothing".
func (s *FileStore) Save(hostID string, repos Repos) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.disabled {
		return nil
	}
	if repos == nil {
		// A nil map marshals to `null`, which ParseLedger would then reject on the
		// way back in.
		repos = Repos{}
	}
	// Sorted so the file is byte-stable between saves that changed nothing; Go's
	// map iteration order would otherwise rewrite the whole ledger every ack.
	paths := make([]string, 0, len(repos))
	for path := range repos {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	ordered := make(map[string][]string, len(repos))
	for _, path := range paths {
		ordered[path] = repos[path]
	}

	document := struct {
		V      int                 `json:"v"`
		HostID string              `json:"hostId"`
		Repos  map[string][]string `json:"repos"`
	}{V: LedgerVersion, HostID: hostID, Repos: ordered}

	data, err := json.Marshal(document)
	if err != nil {
		s.disabled = true
		return err
	}
	if err := state.WriteFilePrivate(s.path(hostID), append(data, '\n')); err != nil {
		s.disabled = true
		return err
	}
	return nil
}
