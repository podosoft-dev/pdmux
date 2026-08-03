// Package state locates (and safely creates) the directory the agent keeps
// state in — the commit-detail ledger today, anything else that must survive a
// restart later.
//
// WHY IT IS RESOLVED AND NOT HARDCODED: the same binary runs as a system unit
// (root or a service user, /var/lib/pdmux) and as a user unit (no write access
// to /var, so ~/.local/state/pdmux). Picking the wrong one means either a
// permission error on every write or a ledger that silently lives in the wrong
// home when the unit is switched — both look like "the cache never works".
//
// Ported from apps/agent/src/state.ts, plus the directory/file modes that the
// TypeScript ledger store (src/git/ledger-store.ts) applies to everything it
// puts here.
package state

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

// SystemDir is SYSTEM_STATE_DIR in the TypeScript: where a system unit stores state.
const SystemDir = "/var/lib/pdmux"

// Environment variables that steer resolution.
const (
	EnvStateDir = "PDMUX_STATE_DIR"
	EnvXDGState = "XDG_STATE_HOME"
	EnvHome     = "HOME"
)

// DirMode/FileMode: the state directory names repository paths on this machine
// and the ledger inside it is not something to leave world-readable.
const (
	DirMode  os.FileMode = 0o700
	FileMode os.FileMode = 0o600
)

// DirInput is the environment resolution reads.
type DirInput struct {
	Env map[string]string
	// Home overrides $HOME; empty falls back to the environment, then to the OS.
	Home string
	// Writable reports whether a directory exists and can be written to.
	// Injected in specs; nil uses DefaultWritable.
	Writable func(path string) bool
}

// DefaultWritable reports whether path is a directory this process can write to.
//
// The TypeScript uses access(2) (accessSync(path, W_OK)). Go's portable standard
// library has no access(2), and the checks that look like a substitute — stat and
// the mode bits — answer a different question than the kernel does once uid 0,
// ACLs, or a read-only mount are involved. Creating and removing one temp file
// asks the kernel the question we actually care about: can we put state here?
func DefaultWritable(path string) bool {
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return false
	}
	probe, err := os.CreateTemp(path, ".pdmux-writable-")
	if err != nil {
		return false
	}
	name := probe.Name()
	probe.Close()
	os.Remove(name)
	return true
}

var kernelFS = regexp.MustCompile(`^/(proc|sys)(/|$)`)

// IsRefusedDir reports whether path is on a kernel filesystem.
//
// Those are never a place for state — and pointing at one is worse than useless.
// In Node it was actively dangerous: mkdirSync('/proc/x', { recursive: true })
// SPINS on Node 22 (measured; the non-recursive call throws ENOENT immediately),
// so a typo in PDMUX_STATE_DIR would peg a core inside the daemon instead of
// failing. Go's MkdirAll returns an error there rather than hanging, but the
// refusal stays: a state directory under /proc is a misconfiguration to report,
// not a path to attempt.
func IsRefusedDir(path string) bool {
	return kernelFS.MatchString(path)
}

// ResolveDir picks the state directory for the unit this process is running under.
func ResolveDir(in DirInput) string {
	if explicit := in.Env[EnvStateDir]; explicit != "" && !IsRefusedDir(explicit) {
		return explicit
	}
	writable := in.Writable
	if writable == nil {
		writable = DefaultWritable
	}
	// Only when it ALREADY exists: creating /var/lib/pdmux is the installer's job,
	// and probing it is how the agent knows which unit it is running under.
	if writable(SystemDir) {
		return SystemDir
	}
	if xdg := in.Env[EnvXDGState]; xdg != "" {
		return filepath.Join(xdg, "pdmux")
	}
	home := in.Home
	if home == "" {
		home = in.Env[EnvHome]
	}
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	return filepath.Join(home, ".local", "state", "pdmux")
}

// EnsureDir creates dir (and its parents) with mode 0700.
//
// The returned error is for the caller to surface as the `state.unwritable`
// diagnostic on the next heartbeat, not to exit on: a read-only root or a unit
// running as the wrong user costs the agent its restart-persistent cache, and
// nothing else. Everything the agent reports still works from memory.
func EnsureDir(dir string) error {
	if IsRefusedDir(dir) {
		return fmt.Errorf("refusing a state directory on a kernel filesystem: %s", dir)
	}
	if err := os.MkdirAll(dir, DirMode); err != nil {
		return err
	}
	// MkdirAll's mode is masked by the process umask, and it is ignored outright
	// for a directory that already exists — an inherited 0755 would stay 0755.
	// Chmod is the only way to state the mode we mean.
	return os.Chmod(dir, DirMode)
}

// WriteFilePrivate writes data to path with mode 0600, atomically.
func WriteFilePrivate(path string, data []byte) error {
	if err := EnsureDir(filepath.Dir(path)); err != nil {
		return err
	}
	temp := path + ".tmp"
	write := func() error {
		if err := os.WriteFile(temp, data, FileMode); err != nil {
			return err
		}
		// os.WriteFile's perm applies only when it CREATES the file and is masked
		// by umask even then, so a leftover temp file from an earlier, looser
		// process would keep its old mode. Same trap as Node's writeFileSync,
		// same fix: chmod explicitly.
		if err := os.Chmod(temp, FileMode); err != nil {
			return err
		}
		// Write-then-rename: a crash mid-write must leave the previous file, not a
		// truncated one that parses as "I have nothing".
		return os.Rename(temp, path)
	}
	if err := write(); err != nil {
		os.Remove(temp)
		return err
	}
	return nil
}
