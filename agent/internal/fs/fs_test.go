package fs

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// home builds a throwaway tree and returns its root handle.
func home(t *testing.T) (string, *os.Root) {
	t.Helper()
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "notes.txt"), "alpha\nbeta\n")
	if err := os.Mkdir(filepath.Join(dir, "project"), 0o755); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(dir, "project", "main.go"), "package main\n")
	root, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { root.Close() })
	return dir, root
}

func mustWrite(t *testing.T, name string, body string) {
	t.Helper()
	if err := os.WriteFile(name, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestConfinement(t *testing.T) {
	/**
	 * ⚠ THIS IS THE TEST THE FEATURE EXISTS OR DIES BY.
	 *
	 * Everything else here is a convenience; this is the promise that a dashboard
	 * cannot read a host's `/etc`. It is written against the OUTCOME (nothing
	 * outside the home is ever returned) rather than against any particular
	 * rejection, because the fence is meant to be `os.Root` refusing rather than
	 * this package checking — if somebody later replaces the handle with string
	 * concatenation, these cases have to fail.
	 */
	t.Run("[TC-PDTERM-139] refuses to leave the home directory", func(t *testing.T) {
		dir, root := home(t)
		// A file that plainly exists outside, so a successful escape would be
		// unmistakable rather than an empty result.
		outside := filepath.Join(filepath.Dir(dir), "outside-secret.txt")
		mustWrite(t, outside, "SECRET\n")
		t.Cleanup(func() { os.Remove(outside) })

		for _, name := range []string{
			"../outside-secret.txt",
			"../../outside-secret.txt",
			"project/../../outside-secret.txt",
			"/etc/hosts",
			outside,
			"..",
			"../",
		} {
			file := Read(root, name)
			if file.Error == nil {
				t.Fatalf("Read(%q) was allowed: %q", name, strings.Join(file.Lines, "\n"))
			}
			// ⚠ REFUSED, NOT REINTERPRETED. `path.Clean("/" + name)` would fold
			// `../outside-secret.txt` into `outside-secret.txt` and quietly answer
			// about a DIFFERENT file inside the home — which looked safe here only
			// because that name happens not to exist. On the write path the same
			// fold created `~/escaped.txt` and reported success.
			if message := *file.Error; !strings.Contains(message, "home directory") &&
				!strings.Contains(message, "relative") {
				t.Fatalf("Read(%q) failed for the wrong reason: %s", name, message)
			}
			if strings.Contains(strings.Join(file.Lines, "\n"), "SECRET") {
				t.Fatalf("Read(%q) returned content from outside the home", name)
			}
			listing := List(root, name, 0)
			for _, entry := range listing.Entries {
				if entry.Name == "outside-secret.txt" {
					t.Fatalf("List(%q) listed a path outside the home", name)
				}
			}
		}
	})

	t.Run("[TC-PDTERM-139] does not follow a symlink out of the tree", func(t *testing.T) {
		dir, root := home(t)
		outside := filepath.Join(filepath.Dir(dir), "linked-secret.txt")
		mustWrite(t, outside, "SECRET\n")
		t.Cleanup(func() { os.Remove(outside) })
		if err := os.Symlink(outside, filepath.Join(dir, "escape.txt")); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		if err := os.Symlink(filepath.Dir(dir), filepath.Join(dir, "escape-dir")); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}

		// ⚠ THE LINK IS STILL LISTED, AND MARKED. Hiding it would make the refusal
		// below look like a bug; naming it makes the refusal a property of the file.
		listing := List(root, "", 0)
		var seen bool
		for _, entry := range listing.Entries {
			if entry.Name == "escape.txt" {
				seen = true
				if !entry.Symlink {
					t.Fatal("escape.txt is a symlink and was not reported as one")
				}
			}
		}
		if !seen {
			t.Fatal("the symlink was not listed at all")
		}

		if file := Read(root, "escape.txt"); file.Error == nil {
			t.Fatalf("followed a symlink out of the home: %q", strings.Join(file.Lines, "\n"))
		}
		if out := List(root, "escape-dir", 0); out.Error == nil {
			t.Fatalf("listed through a symlink out of the home: %d entries", len(out.Entries))
		}
	})

	t.Run("[TC-PDTERM-139] a RELATIVE symlink inside the tree still works", func(t *testing.T) {
		// The fence is about leaving, not about links. A directory symlinked to a
		// sibling is ordinary, and refusing it would be a bug of its own.
		dir, root := home(t)
		if err := os.Symlink("project", filepath.Join(dir, "alias")); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		listing := List(root, "alias", 0)
		if listing.Error != nil {
			t.Fatalf("an inside symlink was refused: %s", *listing.Error)
		}
		if len(listing.Entries) != 1 || listing.Entries[0].Name != "main.go" {
			t.Fatalf("alias listed %+v", listing.Entries)
		}
	})

	t.Run("[TC-PDTERM-139] an ABSOLUTE symlink is refused even pointing inside", func(t *testing.T) {
		/**
		 * ⚠ MEASURED, AND KEPT AS A CASE SO NOBODY "FIXES" IT BY ACCIDENT.
		 *
		 * `os.Root` refuses an absolute symlink target outright — it cannot verify
		 * where an absolute path lands without leaving the root, so it declines
		 * rather than guess. That means `~/work -> /home/me/projects/work`, which is
		 * an ordinary thing for a person to have, does not open in the explorer.
		 *
		 * That is the trade this package chose: a fence that is a handle rather than
		 * a check. Making these work would mean resolving the target ourselves and
		 * comparing prefixes — exactly the check-shaped code the design exists to
		 * avoid, and it would reopen the window between checking a path and using
		 * it. The link is listed and marked, and the refusal is reported, so the
		 * path is still reachable by typing it in the terminal.
		 */
		dir, root := home(t)
		if err := os.Symlink(filepath.Join(dir, "project"), filepath.Join(dir, "abs")); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		if listing := List(root, "abs", 0); listing.Error == nil {
			t.Fatal("an absolute symlink target is refused, even inside the home")
		}
	})
}

func TestList(t *testing.T) {
	t.Run("[TC-PDTERM-140] lists one level, directories first", func(t *testing.T) {
		_, root := home(t)
		listing := List(root, "", 0)
		if listing.Error != nil {
			t.Fatalf("unexpected error: %s", *listing.Error)
		}
		if len(listing.Entries) != 2 {
			t.Fatalf("want 2 entries, got %+v", listing.Entries)
		}
		// ⚠ ONE LEVEL. `project/main.go` must NOT be here — a recursive answer on a
		// real home is hundreds of thousands of paths and stale before it arrives.
		if listing.Entries[0].Name != "project" || !listing.Entries[0].Dir {
			t.Fatalf("directories must sort first, got %+v", listing.Entries)
		}
		if listing.Entries[1].Name != "notes.txt" || listing.Entries[1].Dir {
			t.Fatalf("unexpected second entry %+v", listing.Entries[1])
		}
		if listing.Entries[1].Size != len("alpha\nbeta\n") {
			t.Fatalf("size = %d", listing.Entries[1].Size)
		}
		if listing.Entries[1].Modified == 0 {
			t.Fatal("modified time was not reported")
		}
	})

	t.Run("[TC-PDTERM-140] caps a huge directory and says how many it dropped", func(t *testing.T) {
		dir := t.TempDir()
		for i := 0; i < 40; i++ {
			mustWrite(t, filepath.Join(dir, "f"+string(rune('a'+i%26))+string(rune('0'+i/26))), "x")
		}
		root, err := Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		defer root.Close()

		listing := List(root, "", 10)
		if len(listing.Entries) != 10 {
			t.Fatalf("want 10 entries, got %d", len(listing.Entries))
		}
		if !listing.Truncated || listing.Dropped == 0 {
			t.Fatalf("a capped listing must say so: truncated=%v dropped=%d", listing.Truncated, listing.Dropped)
		}
	})

	t.Run("[TC-PDTERM-140] reports a refusal instead of staying silent", func(t *testing.T) {
		// A directory this account cannot read is a fact the screen has to state.
		// Sending nothing leaves it looking like the click was lost.
		_, root := home(t)
		listing := List(root, "nope", 0)
		if listing.Error == nil {
			t.Fatal("a missing directory must come back with a reason")
		}
		if listing.Path != "nope" {
			t.Fatalf("the frame must say which path failed, got %q", listing.Path)
		}
	})
}

func TestRead(t *testing.T) {
	t.Run("[TC-PDTERM-140] reads a file", func(t *testing.T) {
		_, root := home(t)
		file := Read(root, "project/main.go")
		if file.Error != nil {
			t.Fatalf("unexpected error: %s", *file.Error)
		}
		if len(file.Lines) != 1 || file.Lines[0] != "package main" {
			t.Fatalf("lines = %+v", file.Lines)
		}
		if file.Bytes != len("package main\n") {
			t.Fatalf("bytes = %d", file.Bytes)
		}
	})

	t.Run("[TC-PDTERM-140] answers 'binary' instead of sending bytes", func(t *testing.T) {
		dir, root := home(t)
		mustWrite(t, filepath.Join(dir, "logo.png"), "PNG\x00\x01\x02rest")
		file := Read(root, "logo.png")
		if !file.Binary {
			t.Fatal("a NUL in the first 8 KB is binary")
		}
		if len(file.Lines) != 0 {
			t.Fatalf("a binary answer carries no lines, got %d", len(file.Lines))
		}
		if file.Bytes == 0 {
			t.Fatal("the size is still reported for a binary file")
		}
	})

	t.Run("[TC-PDTERM-140] caps bytes, lines and line length", func(t *testing.T) {
		dir, root := home(t)

		// ⚠ BYTES BEFORE LINES. A file over the byte cap must never be split into
		// a million strings first — that is the whole reason for the order.
		mustWrite(t, filepath.Join(dir, "big.txt"), strings.Repeat("a\n", DefaultMaxBytes))
		big := Read(root, "big.txt")
		if !big.Truncated {
			t.Fatal("an oversized file must say it was truncated")
		}
		if len(big.Lines) > DefaultMaxLines {
			t.Fatalf("line cap not applied: %d", len(big.Lines))
		}

		mustWrite(t, filepath.Join(dir, "long.txt"), strings.Repeat("x", DefaultLineCap+50)+"\n")
		long := Read(root, "long.txt")
		if !long.Truncated || len(long.Lines[0]) != DefaultLineCap {
			t.Fatalf("line length cap not applied: %d chars, truncated=%v", len(long.Lines[0]), long.Truncated)
		}
	})

	t.Run("[TC-PDTERM-140] refuses a directory as a file, with a reason", func(t *testing.T) {
		_, root := home(t)
		file := Read(root, "project")
		if file.Error == nil {
			t.Fatal("reading a directory must come back with a reason")
		}
	})
}

func TestChunk(t *testing.T) {
	// A body long enough to need three slices at a cap this test sets by hand.
	const body = "0123456789abcdefghij"

	read := func(t *testing.T, root *os.Root, name string, offset int64, length int) FsChunkResult {
		t.Helper()
		chunk := Chunk(root, name, offset, length)
		if chunk.Error != nil {
			t.Fatalf("unexpected error: %s", *chunk.Error)
		}
		raw, err := base64.StdEncoding.DecodeString(chunk.Data)
		if err != nil {
			t.Fatalf("data is not base64: %v", err)
		}
		return FsChunkResult{Text: string(raw), Size: chunk.Size, EOF: chunk.EOF, Offset: chunk.Offset}
	}

	t.Run("[TC-PDTERM-142] walks a file by offset and says when it has finished", func(t *testing.T) {
		dir, root := home(t)
		mustWrite(t, filepath.Join(dir, "blob.bin"), body)

		first := read(t, root, "blob.bin", 0, 8)
		if first.Text != "01234567" || first.Size != len(body) || first.EOF {
			t.Fatalf("first = %+v", first)
		}
		second := read(t, root, "blob.bin", 8, 8)
		if second.Text != "89abcdef" || second.EOF {
			t.Fatalf("second = %+v", second)
		}
		// ⚠ THE TAIL IS THE CASE THAT BREAKS. `ReadAt` returns io.EOF TOGETHER with
		// the last bytes, so treating that error as a failure silently truncates
		// every file whose size is not a multiple of the chunk.
		last := read(t, root, "blob.bin", 16, 8)
		if last.Text != "ghij" || !last.EOF {
			t.Fatalf("last = %+v", last)
		}
	})

	t.Run("[TC-PDTERM-142] past the end is an answer, not an error", func(t *testing.T) {
		dir, root := home(t)
		mustWrite(t, filepath.Join(dir, "blob.bin"), body)
		past := read(t, root, "blob.bin", int64(len(body)), 8)
		if past.Text != "" || !past.EOF || past.Size != len(body) {
			t.Fatalf("past = %+v", past)
		}
	})

	t.Run("[TC-PDTERM-142] a nonsense length is clamped, never trusted", func(t *testing.T) {
		dir, root := home(t)
		mustWrite(t, filepath.Join(dir, "blob.bin"), body)
		for _, length := range []int{0, -1, DefaultChunkBytes * 4} {
			got := read(t, root, "blob.bin", 0, length)
			if got.Text != body || !got.EOF {
				t.Fatalf("length %d gave %+v", length, got)
			}
		}
	})

	t.Run("[TC-PDTERM-142] refuses a negative offset and a directory", func(t *testing.T) {
		_, root := home(t)
		if chunk := Chunk(root, "notes.txt", -1, 8); chunk.Error == nil {
			t.Fatal("a negative offset is not a place in a file")
		}
		if chunk := Chunk(root, "project", 0, 8); chunk.Error == nil {
			t.Fatal("a directory has no bytes")
		}
	})

	t.Run("[TC-PDTERM-142] sends bytes a text read refuses", func(t *testing.T) {
		// ⚠ THE WHOLE REASON THIS IS A SEPARATE ENTRY POINT. `Read` answers
		// "binary" and sends nothing, which is right for a viewer and useless for a
		// download or an image.
		dir, root := home(t)
		mustWrite(t, filepath.Join(dir, "logo.png"), "PNG\x00\x01\x02rest")
		if file := Read(root, "logo.png"); !file.Binary || len(file.Lines) != 0 {
			t.Fatal("the text read should still refuse this")
		}
		got := read(t, root, "logo.png", 0, 0)
		if got.Text != "PNG\x00\x01\x02rest" || !got.EOF {
			t.Fatalf("chunk = %+v", got)
		}
	})

	t.Run("[TC-PDTERM-142] cannot leave the home either", func(t *testing.T) {
		// The fence is the handle, so this needs no new check — but a byte reader
		// that quietly grew its own path handling would not fail anywhere else.
		_, root := home(t)
		for _, name := range []string{"../outside.txt", "/etc/hosts", "project/../../outside.txt"} {
			if chunk := Chunk(root, name, 0, 8); chunk.Error == nil {
				t.Fatalf("%q escaped the root", name)
			}
		}
	})
}

// FsChunkResult is what the helper above hands back — the decoded bytes plus the
// three fields a caller decides on.
type FsChunkResult struct {
	Text   string
	Size   int
	EOF    bool
	Offset int
}

func TestWrite(t *testing.T) {
	t.Run("[TC-PDTERM-145] creates a file, then appends slice by slice", func(t *testing.T) {
		dir, root := home(t)
		first := Write(root, "up/notes.txt", 0, []byte("hello "), true)
		if first.Error == nil {
			t.Fatal("a missing parent directory is refused, not created silently")
		}
		// The panel uploads into a directory it is looking at, so this is the case.
		first = Write(root, "notes-new.txt", 0, []byte("hello "), true)
		if first.Error != nil {
			t.Fatalf("unexpected error: %s", *first.Error)
		}
		if first.Written != 6 || first.Size != 6 {
			t.Fatalf("first = %+v", first)
		}
		second := Write(root, "notes-new.txt", 6, []byte("world"), false)
		if second.Error != nil || second.Written != 5 || second.Size != 11 {
			t.Fatalf("second = %+v", second)
		}
		body, err := os.ReadFile(filepath.Join(dir, "notes-new.txt"))
		if err != nil || string(body) != "hello world" {
			t.Fatalf("body = %q err = %v", body, err)
		}
	})

	t.Run("[TC-PDTERM-145] only the FIRST slice truncates", func(t *testing.T) {
		// ⚠ THE FAILURE THIS GUARDS IS SILENT: `create` on every slice leaves a file
		// containing only the last megabyte, and nothing errors.
		dir, root := home(t)
		Write(root, "big.bin", 0, []byte("aaaa"), true)
		Write(root, "big.bin", 4, []byte("bbbb"), false)
		body, _ := os.ReadFile(filepath.Join(dir, "big.bin"))
		if string(body) != "aaaabbbb" {
			t.Fatalf("body = %q", body)
		}
		// And a second upload of the same name starts over rather than merging.
		Write(root, "big.bin", 0, []byte("cc"), true)
		body, _ = os.ReadFile(filepath.Join(dir, "big.bin"))
		if string(body) != "cc" {
			t.Fatalf("re-uploaded body = %q", body)
		}
	})

	t.Run("[TC-PDTERM-145] a new file is not readable by the rest of the machine", func(t *testing.T) {
		dir, root := home(t)
		if wrote := Write(root, "secret.env", 0, []byte("TOKEN=x"), true); wrote.Error != nil {
			t.Fatalf("unexpected error: %s", *wrote.Error)
		}
		info, err := os.Stat(filepath.Join(dir, "secret.env"))
		if err != nil {
			t.Fatal(err)
		}
		if mode := info.Mode().Perm(); mode != 0o600 {
			t.Fatalf("mode = %o, want 600 — a file arriving from a browser is not world-readable", mode)
		}
	})

	t.Run("[TC-PDTERM-145] cannot write outside the home", func(t *testing.T) {
		_, root := home(t)
		for _, name := range []string{"../escaped.txt", "/tmp/escaped.txt", "project/../../escaped.txt"} {
			if wrote := Write(root, name, 0, []byte("x"), true); wrote.Error == nil {
				t.Fatalf("%q escaped the root", name)
			}
		}
		if _, err := os.Stat(filepath.Join(t.TempDir(), "..", "escaped.txt")); err == nil {
			t.Fatal("something was written outside the root")
		}
	})

	t.Run("[TC-PDTERM-145] refuses a slice larger than the cap", func(t *testing.T) {
		_, root := home(t)
		if wrote := Write(root, "huge.bin", 0, make([]byte, DefaultChunkBytes+1), true); wrote.Error == nil {
			t.Fatal("the cap is what bounds a frame; a bigger slice is a broken caller")
		}
	})
}

func TestRemove(t *testing.T) {
	t.Run("[TC-PDTERM-146] removes a file and counts what went", func(t *testing.T) {
		dir, root := home(t)
		removed := Remove(root, "notes.txt", false)
		if removed.Error != nil || removed.Removed != 1 {
			t.Fatalf("removed = %+v", removed)
		}
		if _, err := os.Stat(filepath.Join(dir, "notes.txt")); !os.IsNotExist(err) {
			t.Fatal("the file is still there")
		}
		// "Nothing was there" is a different answer from "one file went".
		again := Remove(root, "notes.txt", false)
		if again.Error == nil || again.Removed != 0 {
			t.Fatalf("again = %+v", again)
		}
	})

	t.Run("[TC-PDTERM-146] refuses a non-empty directory unless asked recursively", func(t *testing.T) {
		// ⚠ THE REFUSAL IS THE FEATURE. "Delete this folder" and "delete this folder
		// and everything in it" are different sentences, and the screen can only ask
		// the second honestly if the first cannot quietly do it.
		dir, root := home(t)
		shallow := Remove(root, "project", false)
		if shallow.Error == nil {
			t.Fatal("a non-empty directory went without anybody saying recursive")
		}
		if _, err := os.Stat(filepath.Join(dir, "project", "main.go")); err != nil {
			t.Fatal("the refusal did not leave the contents alone")
		}
		deep := Remove(root, "project", true)
		if deep.Error != nil || deep.Removed != 2 {
			t.Fatalf("deep = %+v (want the file and the directory)", deep)
		}
	})

	t.Run("[TC-PDTERM-146] will not remove the home itself", func(t *testing.T) {
		dir, root := home(t)
		for _, name := range []string{"", ".", "/"} {
			if removed := Remove(root, name, true); removed.Error == nil {
				t.Fatalf("%q removed the home directory", name)
			}
		}
		if _, err := os.Stat(filepath.Join(dir, "notes.txt")); err != nil {
			t.Fatal("the home was emptied")
		}
	})

	t.Run("[TC-PDTERM-146] unlinks a symlink instead of what it points at", func(t *testing.T) {
		// ⚠ THE ONE PLACE THE ROOT HANDLE WOULD NOT SAVE US: the link is inside the
		// home, so following it is allowed — and following it would delete the
		// target, which may be anywhere.
		dir, root := home(t)
		outside := filepath.Join(t.TempDir(), "keep.txt")
		mustWrite(t, outside, "keep me")
		if err := os.Symlink(outside, filepath.Join(dir, "link")); err != nil {
			t.Fatal(err)
		}
		if removed := Remove(root, "link", true); removed.Error != nil || removed.Removed != 1 {
			t.Fatalf("removed = %+v", removed)
		}
		if _, err := os.Stat(outside); err != nil {
			t.Fatal("the link's TARGET was deleted")
		}
	})

	t.Run("[TC-PDTERM-146] cannot remove outside the home", func(t *testing.T) {
		_, root := home(t)
		keep := filepath.Join(t.TempDir(), "keep.txt")
		mustWrite(t, keep, "keep me")
		for _, name := range []string{"../keep.txt", keep, "project/../../keep.txt"} {
			if removed := Remove(root, name, true); removed.Error == nil {
				t.Fatalf("%q escaped the root", name)
			}
		}
		if _, err := os.Stat(keep); err != nil {
			t.Fatal("a file outside the home was deleted")
		}
	})
}

func TestOpen(t *testing.T) {
	t.Run("[TC-PDTERM-138] no home is a fact, not a failure", func(t *testing.T) {
		// A service account with no home has nothing to browse. The capability is
		// announced only when this succeeds, so the screen never offers a control
		// that cannot act.
		if _, err := Open(""); err != ErrNoHome {
			t.Fatalf("want ErrNoHome, got %v", err)
		}
	})
}
