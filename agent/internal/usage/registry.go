package usage

// Turn the ids the server sent (`usageProviders: ["claude","codex"]`) into
// provider instances.
//
// WHY A REGISTRY AND NOT A SWITCH IN THE COLLECTOR: the core must not know which
// coding CLIs exist. This file is the ONLY place in the agent that may name one,
// and it names exactly two because they cover the two shapes seen in the wild (a
// snapshot file and a session transcript). Every other id falls back to the generic
// snapshot path, so a new CLI can be integrated by a wrapper that writes one
// small JSON file — no agent release required.
//
// Ported from apps/agent/src/usage/registry.ts.

import (
	"os"
	"path/filepath"
	"strings"
)

// RegistryOptions are the injectable parts. A zero value builds providers that
// read the real host.
type RegistryOptions struct {
	Home string
	// ReadFile is a test seam — passed straight through to the file provider.
	ReadFile ReadFileFunc
	ProcDir  string
	Now      func() int64
}

// GenericSnapshotPath is where a wrapper for an unknown provider drops its
// snapshot.
func GenericSnapshotPath(home, id string) string {
	return filepath.Join(home, ".config", "pdmux", "usage", id+".json")
}

// LegacySnapshotNames are snapshot file names written by earlier tools, read only when
// the canonical path is absent.
//
// ⚠ THIS LIST IS COMPATIBILITY, NOT CONFIGURATION. The snapshot is produced by a
// statusline wrapper the operator installed once and forgot; it survives the deployment
// that told them to install it. Measured on this fleet: a wrapper from the predecessor
// tool was writing a valid snapshot every few seconds into `dev-ws-usage.json` while the
// agent read `pdmux-usage.json`, so the card said "no budget reported" beside five live
// processes and nothing anywhere said why. Adding a name here is cheap (one `stat` on a
// miss); leaving an operator with a silently dead card is not.
var LegacySnapshotNames = []string{"dev-ws-usage.json"}

func legacySnapshotPaths(dir string) []string {
	out := make([]string, 0, len(LegacySnapshotNames))
	for _, name := range LegacySnapshotNames {
		out = append(out, filepath.Join(dir, name))
	}
	return out
}

// NewProvider builds the adapter for one provider id.
func NewProvider(id string, options RegistryOptions) Provider {
	home := options.Home
	if home == "" {
		// An unresolvable home is not fatal: the generic path then resolves relative
		// to the working directory, misses, and the provider simply reports nothing.
		home, _ = os.UserHomeDir()
	}
	switch id {
	case "codex":
		// ⚠ THE TRANSCRIPT, NOT THE CLI. Spawning it cost ~134 MiB and ~0.28 s of
		// CPU every pass because the launcher execs a 259 MB native binary — more
		// than the entire rest of the agent — while the same numbers were already
		// being appended to the session transcript on disk. See rollout.go.
		//
		// The spawn stays as a FALLBACK, not as the path: a host with transcripts
		// turned off, or one where the CLI has never run, would otherwise report
		// "no budget" forever. It is reached only when the file yields nothing, so
		// the normal case pays none of it.
		return NewFirstAnswering(id,
			NewRolloutFileProvider(RolloutFileOptions{
				ID:      id,
				Root:    filepath.Join(home, ".codex", "sessions"),
				ProcDir: options.ProcDir,
				Now:     options.Now,
			}),
			NewRPCCLIProvider(RPCCLIOptions{ID: id, ProcDir: options.ProcDir, Now: options.Now, Home: home}),
		)
	case "claude":
		return NewSnapshotFileProvider(SnapshotFileOptions{
			ID:        id,
			Path:      filepath.Join(home, ".claude", "pdmux-usage.json"),
			Fallbacks: legacySnapshotPaths(filepath.Join(home, ".claude")),
			ReadFile:  options.ReadFile,
			ProcDir:   options.ProcDir,
			Now:       options.Now,
		})
	default:
		return NewSnapshotFileProvider(SnapshotFileOptions{
			ID:        id,
			Path:      GenericSnapshotPath(home, id),
			Fallbacks: legacySnapshotPaths(filepath.Join(home, "."+id)),
			ReadFile:  options.ReadFile,
			ProcDir:   options.ProcDir,
			Now:       options.Now,
		})
	}
}

// NewProviders builds one adapter per configured id, ignoring blanks and
// duplicates — the same CLI listed twice would otherwise be spawned twice and
// reported as two rows for one budget.
func NewProviders(ids []string, options RegistryOptions) []Provider {
	seen := make(map[string]bool, len(ids))
	out := []Provider{}
	for _, id := range ids {
		trimmed := strings.TrimSpace(id)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, NewProvider(trimmed, options))
	}
	return out
}
