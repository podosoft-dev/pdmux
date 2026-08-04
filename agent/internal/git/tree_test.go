package git

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestTree(t *testing.T) {
	ctx := context.Background()

	// A runner that answers with canned output and records the argv it was handed.
	stub := func(out string, err error) (Runner, *[]string) {
		seen := &[]string{}
		return func(_ context.Context, args []string, _ CallOptions) (string, error) {
			*seen = append(*seen, strings.Join(args, " "))
			return out, err
		}, seen
	}

	// `ls-tree -r --long -z` records: `<mode> <type> <object> <size>\t<path>\0`
	record := func(kind, object string, size int, path string) string {
		return "100644 " + kind + " " + object + " " + strings.Repeat(" ", 0) + itoa(size) + "\t" + path + "\x00"
	}

	t.Run("[TC-PDGIT-015] lists the blobs at a commit with their sizes", func(t *testing.T) {
		run, seen := stub(
			record("blob", "aaaa", 12, "src/deep/a.ts")+
				record("blob", "bbbb", 3, "b.txt")+
				// A submodule has no contents on this host to show.
				record("commit", "cccc", 0, "vendor/thing"),
			nil)

		entries, dropped, err := ReadTree(ctx, run, "abc1234", 0)
		if err != nil {
			t.Fatalf("ReadTree: %v", err)
		}
		if len(entries) != 2 {
			t.Fatalf("entries = %+v, want the two blobs only", entries)
		}
		if entries[0].Path != "src/deep/a.ts" || entries[0].Size != 12 {
			t.Fatalf("first entry = %+v", entries[0])
		}
		if dropped != 0 {
			t.Fatalf("dropped = %d", dropped)
		}
		// ⚠ THE ARGV IS THE ASSERTION. `-z` keeps git from C-quoting a path with a
		// space or a non-ASCII byte in it — quoted, the same file no longer matches
		// the path the diff reported. `--long` is what carries the size.
		if len(*seen) != 1 {
			t.Fatalf("ran %v, want a single call", *seen)
		}
		for _, flag := range []string{"ls-tree", "-r", "--long", "-z"} {
			if !strings.Contains((*seen)[0], flag) {
				t.Fatalf("argv %q is missing %q", (*seen)[0], flag)
			}
		}
	})

	t.Run("[TC-PDGIT-015] keeps a path that git would have quoted", func(t *testing.T) {
		// A space and a multi-byte name: both are what `-z` exists for.
		run, _ := stub(record("blob", "aaaa", 4, "docs/한글 문서.md"), nil)
		entries, _, err := ReadTree(ctx, run, "abc1234", 0)
		if err != nil {
			t.Fatalf("ReadTree: %v", err)
		}
		if len(entries) != 1 || entries[0].Path != "docs/한글 문서.md" {
			t.Fatalf("entries = %+v, want the raw path", entries)
		}
	})

	t.Run("[TC-PDGIT-015] stops at the cap and says how many it dropped", func(t *testing.T) {
		var b strings.Builder
		for i := 0; i < 20; i++ {
			b.WriteString(record("blob", "aaaa", 1, "f"+itoa(i)+".txt"))
		}
		run, _ := stub(b.String(), nil)
		entries, dropped, err := ReadTree(ctx, run, "abc1234", 5)
		if err != nil {
			t.Fatalf("ReadTree: %v", err)
		}
		if len(entries) != 5 || dropped != 15 {
			t.Fatalf("entries = %d dropped = %d, want 5 and 15", len(entries), dropped)
		}
	})

	t.Run("[TC-PDGIT-015] reads one file and trims it on BOTH bytes and lines", func(t *testing.T) {
		// ⚠ ONE LONG LINE IS THE CASE A LINE CAP MISSES. A minified bundle is a
		// single line of megabytes, which is exactly how the diff caps were learnt.
		run, _ := stub(strings.Repeat("x", DefaultBlobMaxBytes+1_000), nil)
		blob, err := ReadBlob(ctx, run, "abc1234", "bundle.js")
		if err != nil {
			t.Fatalf("ReadBlob: %v", err)
		}
		if !blob.Truncated {
			t.Fatal("a file past the byte cap was not marked truncated")
		}
		for _, line := range blob.Lines {
			if len(line) > DefaultBlobLineCap {
				t.Fatalf("a line of %d chars survived the per-line cap", len(line))
			}
		}
		if blob.Bytes != DefaultBlobMaxBytes+1_000 {
			t.Fatalf("bytes = %d, want the size on disk rather than what was sent", blob.Bytes)
		}
	})

	t.Run("[TC-PDGIT-015] calls a binary file binary instead of sending its bytes", func(t *testing.T) {
		run, _ := stub("\x89PNG\x00\x00\x00\rIHDR", nil)
		blob, err := ReadBlob(ctx, run, "abc1234", "logo.png")
		if err != nil {
			t.Fatalf("ReadBlob: %v", err)
		}
		if !blob.Binary {
			t.Fatal("a file with a NUL in it was treated as text")
		}
		if len(blob.Lines) != 0 {
			t.Fatalf("lines = %+v, want none for a binary file", blob.Lines)
		}
	})

	/**
	 * ⚠ A FAILURE IS AN ANSWER. A sha this checkout does not have — after a
	 * force-push, or a commit only the remote knows — is a fact the screen has to
	 * state; sending nothing leaves the click looking lost.
	 */
	t.Run("[TC-PDGIT-015] reports an unreadable tree rather than sending nothing", func(t *testing.T) {
		run, _ := stub("", errors.New("fatal: not a tree object"))
		snapshot := CollectTreeSnapshot(ctx, TreeOptions{
			Path: "/repo", Name: "repo", SHA: "abc1234", Run: run, Now: func() int64 { return 1_784_000_000 },
		})
		if snapshot.Tree == nil || snapshot.Tree.Error == nil {
			t.Fatal("the failure was swallowed")
		}
		// ⚠ PARTIAL, like a detail or a remote check: refs and commit rows did not
		// change because somebody opened a file list.
		if !snapshot.Partial || len(snapshot.Commits) != 0 || len(snapshot.Refs) != 0 {
			t.Fatal("a tree request rebuilt the graph")
		}
	})

	t.Run("[TC-PDGIT-015] asks for the file with show, which writes nothing", func(t *testing.T) {
		run, seen := stub("one\ntwo\n", nil)
		snapshot := CollectBlobSnapshot(ctx, BlobOptions{
			Path: "/repo", Name: "repo", SHA: "abc1234", FilePath: "src/a.ts", Run: run,
			Now: func() int64 { return 1_784_000_000 },
		})
		if snapshot.Blob == nil || len(snapshot.Blob.Lines) != 2 {
			t.Fatalf("blob = %+v", snapshot.Blob)
		}
		// `show <sha>:<path>` — the subcommand is the assertion, the way it is for
		// `ls-remote`: this one reads the object database and changes nothing.
		if len(*seen) != 1 || !strings.HasPrefix((*seen)[0], "show abc1234:src/a.ts") {
			t.Fatalf("ran %v, want a single show", *seen)
		}
	})
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := ""
	for n > 0 {
		digits = string(rune('0'+n%10)) + digits
		n /= 10
	}
	return digits
}
