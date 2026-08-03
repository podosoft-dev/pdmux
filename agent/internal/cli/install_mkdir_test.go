package cli

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// A non-root service user has to traverse every directory above the binary. The
// installer runs under `umask 077` so a credential is never written world
// readable, and MkdirAll masks intermediate directories with that umask -- which
// left /opt/pdmux at 0700 root while the plan said 0755, and systemd failed with
// 203/EXEC on a binary that was itself perfectly fine.
func TestMkdirAllAppliesModeToCreatedAncestors(t *testing.T) {
	previous := syscall.Umask(0o077)
	defer syscall.Umask(previous)

	root := t.TempDir()
	target := filepath.Join(root, "opt", "pdmux", "bin")
	if err := mkdirAll(target, 0o755, true); err != nil {
		t.Fatalf("mkdirAll: %v", err)
	}

	for _, dir := range []string{
		filepath.Join(root, "opt"),
		filepath.Join(root, "opt", "pdmux"),
		target,
	} {
		info, err := os.Stat(dir)
		if err != nil {
			t.Fatalf("stat %s: %v", dir, err)
		}
		if got := info.Mode().Perm(); got != 0o755 {
			t.Errorf("%s has mode %o, want 755 — a non-root user cannot traverse it", dir, got)
		}
	}
}

// The private modes still have to stay private: widening them would put a
// credential where another account can read it.
func TestMkdirAllKeepsPrivateModePrivate(t *testing.T) {
	previous := syscall.Umask(0o022)
	defer syscall.Umask(previous)

	root := t.TempDir()
	target := filepath.Join(root, "etc", "pdmux")
	if err := mkdirAll(target, 0o700, true); err != nil {
		t.Fatalf("mkdirAll: %v", err)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o700 {
		t.Errorf("config directory has mode %o, want 700", got)
	}
}
