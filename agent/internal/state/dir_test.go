package state

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveDir(t *testing.T) {
	never := func(string) bool { return false }

	t.Run("[TC-PDAGENT-037] refuses a state dir on a kernel filesystem", func(t *testing.T) {
		// A typo here used to peg a core in Node (recursive mkdir on /proc spins),
		// so the refusal is checked, not assumed.
		for _, refused := range []string{"/proc/pdmux", "/sys/fs/pdmux"} {
			got := ResolveDir(DirInput{
				Env:      map[string]string{EnvStateDir: refused},
				Home:     "/home/dev",
				Writable: never,
			})
			if got != "/home/dev/.local/state/pdmux" {
				t.Fatalf("PDMUX_STATE_DIR=%s resolved to %q, want the home fallback", refused, got)
			}
		}
		if !IsRefusedDir("/proc") || !IsRefusedDir("/sys/kernel") {
			t.Fatal("kernel filesystems must be refused")
		}
		if IsRefusedDir("/procyon/pdmux") || IsRefusedDir("/var/lib/pdmux") {
			t.Fatal("a path that merely starts with the same letters is a real directory")
		}
	})

	t.Run("[TC-PDAGENT-037] resolves the state dir from the environment it runs in", func(t *testing.T) {
		if got := ResolveDir(DirInput{Env: map[string]string{EnvStateDir: "/srv/pdmux"}}); got != "/srv/pdmux" {
			t.Fatalf("explicit dir = %q", got)
		}
		// A system unit: /var/lib/pdmux already exists and is writable.
		if got := ResolveDir(DirInput{Home: "/home/dev", Writable: func(string) bool { return true }}); got != SystemDir {
			t.Fatalf("system unit resolved to %q, want %q", got, SystemDir)
		}
		// A user unit: no write access to /var.
		if got := ResolveDir(DirInput{Home: "/home/dev", Writable: never}); got != "/home/dev/.local/state/pdmux" {
			t.Fatalf("user unit resolved to %q", got)
		}
		if got := ResolveDir(DirInput{
			Env:      map[string]string{EnvXDGState: "/xdg"},
			Home:     "/home/dev",
			Writable: never,
		}); got != "/xdg/pdmux" {
			t.Fatalf("XDG_STATE_HOME resolved to %q", got)
		}
		if got := ResolveDir(DirInput{
			Env:      map[string]string{"HOME": "/home/from-env"},
			Writable: never,
		}); got != "/home/from-env/.local/state/pdmux" {
			t.Fatalf("HOME fallback resolved to %q", got)
		}
	})

	t.Run("[TC-PDAGENT-037] reports a real directory as writable and a missing one as not", func(t *testing.T) {
		dir := t.TempDir()
		if !DefaultWritable(dir) {
			t.Fatal("a fresh temp dir must be writable")
		}
		if DefaultWritable(filepath.Join(dir, "absent")) {
			t.Fatal("a missing directory is not writable")
		}
		file := filepath.Join(dir, "a-file")
		if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		if DefaultWritable(file) {
			t.Fatal("a regular file is not a state directory")
		}
		// The probe must not litter: a state dir is inspected on every start.
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 1 {
			t.Fatalf("writability probe left %d entries behind", len(entries)-1)
		}
	})
}

func TestStateFiles(t *testing.T) {
	t.Run("[TC-PDAGENT-037] creates the state directory 0700", func(t *testing.T) {
		dir := filepath.Join(t.TempDir(), "nested", "pdmux")
		if err := EnsureDir(dir); err != nil {
			t.Fatal(err)
		}
		assertMode(t, dir, 0o700)
		// An existing, looser directory is tightened rather than accepted: MkdirAll
		// ignores its mode argument for a directory that already exists.
		if err := os.Chmod(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := EnsureDir(dir); err != nil {
			t.Fatal(err)
		}
		assertMode(t, dir, 0o700)
	})

	t.Run("[TC-PDAGENT-037] writes state 0600 and atomically", func(t *testing.T) {
		dir := filepath.Join(t.TempDir(), "pdmux")
		path := filepath.Join(dir, "details-host.json")
		if err := WriteFilePrivate(path, []byte("{}\n")); err != nil {
			t.Fatal(err)
		}
		assertMode(t, path, 0o600)
		assertMode(t, dir, 0o700)

		// A leftover temp file from a looser process must not donate its mode.
		if err := os.WriteFile(path+".tmp", []byte("stale"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := WriteFilePrivate(path, []byte(`{"v":1}`)); err != nil {
			t.Fatal(err)
		}
		assertMode(t, path, 0o600)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != `{"v":1}` {
			t.Fatalf("content = %q", data)
		}
		if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
			t.Fatal("the temp file must be renamed away, not left next to the state file")
		}
	})

	t.Run("[TC-PDAGENT-037] keeps an unwritable state dir non-fatal", func(t *testing.T) {
		// A path whose parent is a file: the state dir can never be created here.
		// The caller reports this as the state.unwritable diagnostic; nothing crashes.
		if err := EnsureDir("/dev/null/pdmux"); err == nil {
			t.Fatal("expected an error, not a created directory")
		}
		if err := WriteFilePrivate("/dev/null/pdmux/details.json", []byte("{}")); err == nil {
			t.Fatal("expected an error from an impossible state directory")
		}
		if err := EnsureDir("/proc/pdmux"); err == nil {
			t.Fatal("a kernel filesystem must be refused before mkdir is attempted")
		}
	})
}

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("mode of %s = %o, want %o", path, got, want)
	}
}
