package git

import (
	"context"
	"strconv"
	"strings"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// DefaultTreeEntryCap bounds one tree listing.
//
// A checkout with more paths than this exists (a monorepo with vendored
// dependencies clears it easily), and the honest answer there is "here are five
// thousand of them and N more" rather than a frame the server will reject.
const DefaultTreeEntryCap = 5_000

// Blob caps. Bytes AND lines, because either alone lets the other through: a
// minified bundle is one line of two megabytes, and a log file is a million
// short ones.
const (
	DefaultBlobMaxBytes = 256_000
	DefaultBlobMaxLines = 4_000
	DefaultBlobLineCap  = 500
)

// binarySniffBytes is how much of a file is examined for a NUL.
//
// The same window git itself uses. A text file with a NUL in it past 8000 bytes
// is not a case worth paying a full scan of every file for.
const binarySniffBytes = 8_000

// ReadTree lists every path that existed at one commit.
//
// ⚠ `ls-tree` READS THE OBJECT DATABASE AND WRITES NOTHING — the same argument
// that put `ls-remote` on the whitelist while `fetch` stayed off it. It does not
// touch the index, the working tree or any ref; a repository somebody is working
// in is byte-for-byte unchanged afterwards, which is the guarantee this package
// exists to keep.
//
// ⚠ `-z` IS NOT OPTIONAL. Without it git quotes any path containing a space, a
// newline or a byte outside ASCII, using its own C-style escaping — so a file
// whose name is not plain ASCII comes back wrapped in quotes with every such
// byte written as `\NNN`, and that string no longer matches the path the diff
// reported for the same file. With `-z` the path is raw and the record separator
// is a NUL, which cannot occur in a path at all. `tree_test.go` holds the
// fixture that proves it.
func ReadTree(ctx context.Context, run Runner, sha string, cap int) ([]protocol.GitTreeEntry, int, error) {
	if cap <= 0 {
		cap = DefaultTreeEntryCap
	}
	// `--long` adds the blob size, which is what lets the UI say how big a file is
	// before anybody asks for its contents.
	out, err := run(ctx, []string{"ls-tree", "-r", "--long", "-z", sha}, CallOptions{})
	if err != nil {
		return nil, 0, err
	}
	entries, dropped := parseTree(out, cap)
	return entries, dropped, nil
}

// parseTree turns `ls-tree -r --long -z` output into contract rows.
//
// Each record is `<mode> SP <type> SP <object> SP <size> TAB <path>` and records
// are NUL-separated. Only blobs are listed: `-r` already flattens directories
// away, and a submodule (`commit`) has no contents on this host to show.
func parseTree(out string, cap int) ([]protocol.GitTreeEntry, int) {
	entries := make([]protocol.GitTreeEntry, 0, 64)
	dropped := 0
	for _, record := range strings.Split(out, "\x00") {
		if record == "" {
			continue
		}
		meta, path, ok := strings.Cut(record, "\t")
		if !ok || path == "" {
			continue
		}
		bits := strings.Fields(meta)
		// mode, type, object, size — anything shorter is not a row we understand.
		if len(bits) < 4 || bits[1] != "blob" {
			continue
		}
		if len(entries) >= cap {
			dropped++
			continue
		}
		// `--long` prints `-` for an object whose size git did not compute.
		size, err := strconv.Atoi(bits[3])
		if err != nil || size < 0 {
			size = 0
		}
		entries = append(entries, protocol.GitTreeEntry{Path: path, Size: size})
	}
	return entries, dropped
}

// ReadBlob reads one file as it stood at one commit.
//
// `show <sha>:<path>` is already on the read-only whitelist and reads the object
// database exactly the way `ls-tree` does.
//
// ⚠ THE ANSWER FOR A BINARY FILE IS "binary", NOT ITS BYTES. A browser renders
// none of them, and a PNG in a JSON frame is the payload this contract has been
// trimmed twice to avoid. Detection is a NUL in the first 8 KB — git's own test.
func ReadBlob(ctx context.Context, run Runner, sha string, path string) (protocol.GitBlob, error) {
	blob := protocol.NewGitBlob()
	blob.SHA = sha
	blob.Path = path

	out, err := run(ctx, []string{"show", sha + ":" + path}, CallOptions{})
	if err != nil {
		return blob, err
	}
	blob.Bytes = len(out)
	if isBinary(out) {
		blob.Binary = true
		return blob, nil
	}

	// ⚠ TRUNCATE THE BYTES BEFORE SPLITTING. Splitting first materialises every
	// line of a 40 MB file in memory to then throw almost all of it away, on a
	// machine whose job is somebody else's work.
	if len(out) > DefaultBlobMaxBytes {
		out = out[:DefaultBlobMaxBytes]
		blob.Truncated = true
	}
	lines := strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	if len(lines) > DefaultBlobMaxLines {
		lines = lines[:DefaultBlobMaxLines]
		blob.Truncated = true
	}
	for i, line := range lines {
		line = strings.TrimRight(line, "\r")
		if tooLong(line, DefaultBlobLineCap) {
			line = clip(line, DefaultBlobLineCap)
			blob.Truncated = true
		}
		lines[i] = line
	}
	blob.Lines = lines
	return blob, nil
}

func isBinary(content string) bool {
	window := content
	if len(window) > binarySniffBytes {
		window = window[:binarySniffBytes]
	}
	return strings.IndexByte(window, 0) >= 0
}

// TreeOptions is one `fileTree` request.
type TreeOptions struct {
	Path string
	Name string
	SHA  string
	Cap  int
	Run  Runner
	Now  func() int64
}

// BlobOptions is one `fileContent` request.
type BlobOptions struct {
	Path     string
	Name     string
	SHA      string
	FilePath string
	Run      Runner
	Now      func() int64
}

// CollectTreeSnapshot answers a tree request with a PARTIAL snapshot.
//
// The shape `CollectDetailSnapshot` and `CollectRemoteSnapshot` already use:
// refs and commit rows did not change because somebody opened a file list, the
// server holds them, and rebuilding them would spend a full graph pass to
// deliver one list of paths.
//
// ⚠ A FAILURE TRAVELS IN THE FRAME. A sha this checkout does not have — after a
// force-push, or a commit only the remote knows — is a fact the screen has to be
// able to state, and sending nothing leaves it looking like the click was lost.
func CollectTreeSnapshot(ctx context.Context, options TreeOptions) protocol.RepoSnapshot {
	snapshot := partialSnapshot(options.Path, options.Name, nowOr(options.Now))
	tree := protocol.NewGitTree()
	tree.SHA = options.SHA

	run := options.Run
	if run == nil {
		run = NewRunner(options.Path)
	}
	entries, dropped, err := ReadTree(ctx, run, options.SHA, options.Cap)
	if err != nil {
		message := err.Error()
		tree.Error = &message
	} else {
		tree.Entries = entries
		tree.Dropped = dropped
		tree.Truncated = dropped > 0
	}
	snapshot.Tree = &tree
	return snapshot
}

// CollectBlobSnapshot answers a file-content request with a PARTIAL snapshot.
func CollectBlobSnapshot(ctx context.Context, options BlobOptions) protocol.RepoSnapshot {
	snapshot := partialSnapshot(options.Path, options.Name, nowOr(options.Now))

	run := options.Run
	if run == nil {
		run = NewRunner(options.Path)
	}
	blob, err := ReadBlob(ctx, run, options.SHA, options.FilePath)
	if err != nil {
		message := err.Error()
		blob.Error = &message
	}
	snapshot.Blob = &blob
	return snapshot
}

func partialSnapshot(path string, name string, at int64) protocol.RepoSnapshot {
	snapshot := protocol.NewRepoSnapshot()
	snapshot.Path = path
	snapshot.Name = name
	snapshot.Ts = at
	snapshot.Partial = true
	return snapshot
}
