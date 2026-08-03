package sys

import (
	"os"
	"path/filepath"
	"testing"
)

// place writes an executable file and returns the directory holding it.
func place(t *testing.T, dir string, name string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("write: %v", err)
	}
	return path
}

func TestWhich(t *testing.T) {
	t.Run("[TC-PDTERM-028] finds a binary a service manager's PATH cannot see", func(t *testing.T) {
		home := t.TempDir()
		want := place(t, filepath.Join(home, ".local", "bin"), "tmux")
		// The PATH a launchd or systemd unit actually gets: system directories and
		// nothing the person installed for themselves.
		t.Setenv("PATH", "/usr/bin:/bin")
		t.Setenv("HOME", home)

		got, found := Which("tmux")
		if !found {
			t.Fatal("Which reported the multiplexer absent while it is installed")
		}
		if got != want {
			t.Fatalf("Which = %q, want %q", got, want)
		}
	})

	t.Run("[TC-PDTERM-028] PATH still wins, so an operator's choice is not overridden", func(t *testing.T) {
		home := t.TempDir()
		place(t, filepath.Join(home, ".local", "bin"), "tmux")
		onPath := t.TempDir()
		want := place(t, onPath, "tmux")
		t.Setenv("PATH", onPath)
		t.Setenv("HOME", home)

		got, _ := Which("tmux")
		if got != want {
			t.Fatalf("Which = %q, want the one on PATH %q", got, want)
		}
	})

	t.Run("[TC-PDTERM-028] says absent when it is absent, rather than guessing a path", func(t *testing.T) {
		// The honest negative is what the refusal message and the `mux.missing`
		// diagnostic both hang off. A lookup that answered "probably over there"
		// would turn one clear refusal into a confusing exec failure.
		t.Setenv("PATH", t.TempDir())
		t.Setenv("HOME", t.TempDir())

		if got, found := Which("pdmux-no-such-binary"); found {
			t.Fatalf("Which = %q, want not found", got)
		}
	})

	t.Run("[TC-PDTERM-028] a directory of the right name is not a binary", func(t *testing.T) {
		// ⚠ NOT NAMED `tmux`. Two of the searched directories are absolute system
		// prefixes, so on a machine that really has tmux this subtest would find the
		// host's own copy and pass while proving nothing. It failed exactly that way
		// once. A name nothing can supply is what makes the negative meaningful.
		const name = "pdmux-fake-binary"
		home := t.TempDir()
		if err := os.MkdirAll(filepath.Join(home, ".local", "bin", name), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		t.Setenv("PATH", t.TempDir())
		t.Setenv("HOME", home)

		if _, found := Which(name); found {
			t.Fatal("a directory was accepted as an executable")
		}
	})
}
