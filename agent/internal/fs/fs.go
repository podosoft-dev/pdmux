// Package fs browses this host's files under the agent user's home directory.
//
// WHY THIS EXISTS AT ALL: the person looking at the dashboard already has a
// terminal on this host, running as this same account — they can `cat` and `rm`
// anything the account reaches. So an explorer is not a new capability, it is a
// nicer way to do what a pane already does, and it is offered only to that
// audience. It is deliberately NOT reachable from an MCP credential, because a
// token with no terminal is a different question with a different answer.
//
// ⚠ THE FENCE IS A HANDLE, NOT A CHECK. Everything here goes through `os.Root`,
// which resolves every name relative to an open directory and refuses to leave
// it — `..`, an absolute path and a symlink pointing outside are all impossible
// rather than rejected, and there is no window between checking a path and using
// it for the filesystem to change underneath. That is why this package contains
// no path validation: validation is code that can be wrong, and the alternative
// here is a guarantee that cannot.
//
// It is the same argument `docs/ARCHITECTURE.md` §4 makes for git being
// read-only — "'we do not write' has to be a STRUCTURE, not a rule" — applied to
// where the agent may look.
//
// ⚠ THE PRICE, MEASURED: `os.Root` refuses an ABSOLUTE symlink target even when
// it points back inside the home, because it cannot tell where an absolute path
// lands without leaving the root. So `~/work -> /home/me/projects/work` — an
// ordinary thing for a person to have — does not open here. Making it work would
// mean resolving the target and comparing prefixes ourselves, which is precisely
// the check-shaped code this design exists to avoid and would reopen the window
// between checking a path and using it. Such a link is listed and MARKED, the
// refusal is reported rather than swallowed, and the terminal beside it can
// still reach the real path. `fs_test.go` keeps that trade as a named case.
//
// ⚠ AND PERMISSIONS ARE THE OPERATING SYSTEM'S JOB. The agent runs as the person
// who installed it, never as root unless somebody installed it from a root login
// (`cli.ServiceUser` picks `SUDO_USER`). A file that account cannot read fails
// with EACCES and that failure is reported as it is. Nothing here re-implements
// a permission model, because doing so could only ever be a second, weaker
// opinion about a question the kernel already answers.
package fs

import (
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path"
	"sort"
	"strings"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// Caps, mirroring the contract's `FS_CAPS`.
//
// The file numbers are deliberately the same as a git blob's: one viewer renders
// both, and two answers to "how much of a file is too much" is one answer that
// will eventually disagree with itself. The entry cap is far smaller than a
// repository tree's, because this bounds a single directory somebody opened
// rather than a whole checkout — and `node_modules` exists.
const (
	DefaultEntryCap = 1_000
	DefaultMaxBytes = 256_000
	DefaultMaxLines = 4_000
	DefaultLineCap  = 500
	// DefaultChunkBytes mirrors the contract's `FS_CHUNK_BYTES`. It bounds a
	// TRANSFER rather than a view, which is why it is far larger than the byte cap
	// above and unrelated to it.
	DefaultChunkBytes = 1_048_576
	binarySniffBytes  = 8_000
	defaultMaxPathLen = 1024
)

// ErrNoHome is returned when this account has no usable home directory.
//
// ⚠ IT IS A FACT ABOUT THE HOST, NOT A FAILURE. A service account with no home
// has nothing to browse, and the honest response is to not offer the feature —
// which is why the capability is announced only when this succeeds.
var ErrNoHome = errors.New("no home directory")

// Open returns a handle rooted at this account's home directory.
//
// ⚠ THE CALLER CLOSES IT, AND ONE IS OPENED PER REQUEST. Holding it open would
// mean holding a directory handle to somebody's home for the life of the agent,
// and it would go stale if the home were replaced underneath. Opening is one
// syscall.
func Open(home string) (*os.Root, error) {
	if home == "" {
		return nil, ErrNoHome
	}
	return os.OpenRoot(home)
}

// List reads ONE directory, relative to the root. An empty name is the root.
//
// ⚠ ONE LEVEL, NEVER A WALK. A home directory holds hundreds of thousands of
// files once a few `node_modules` are in it, and a recursive answer would be
// both enormous and stale before it arrived. The screen asks for the next level
// when somebody opens it.
func List(root *os.Root, name string, cap int) protocol.FsDir {
	dir := protocol.NewFsDir()
	dir.Path = name
	if cap <= 0 {
		cap = DefaultEntryCap
	}

	handle, err := open(root, name)
	if err != nil {
		return failedDir(dir, err)
	}
	defer handle.Close()

	// `-1` would read the whole directory into memory before the cap applies.
	// Reading cap+1 is what lets `dropped` be counted without paying for it.
	records, err := handle.ReadDir(cap + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return failedDir(dir, err)
	}

	entries := make([]protocol.FsEntry, 0, len(records))
	for _, record := range records {
		entry := protocol.NewFsEntry()
		entry.Name = record.Name()
		entry.Dir = record.IsDir()
		// ⚠ `Type()` COMES FROM THE DIRECTORY, NOT FROM FOLLOWING THE LINK. A
		// symlink is reported as one and never resolved: the root handle refuses
		// links that leave the tree, so a reader who was not told it was a link
		// would read that refusal as a bug rather than as the shape of the file.
		entry.Symlink = record.Type()&os.ModeSymlink != 0
		if info, statErr := record.Info(); statErr == nil {
			entry.Size = int(info.Size())
			entry.Modified = int(info.ModTime().Unix())
		}
		entries = append(entries, entry)
	}

	// Directories first, then by name: the order every file manager has taught
	// people to expect, and one the browser does not have to re-derive.
	sort.SliceStable(entries, func(a, b int) bool {
		if entries[a].Dir != entries[b].Dir {
			return entries[a].Dir
		}
		return strings.ToLower(entries[a].Name) < strings.ToLower(entries[b].Name)
	})

	if len(entries) > cap {
		dir.Dropped = len(entries) - cap
		entries = entries[:cap]
		dir.Truncated = true
	}
	dir.Entries = entries
	return dir
}

// Read returns one file's contents, relative to the root.
//
// The order of the caps is copied from `git/tree.go` and the reason is the same:
// truncating the bytes BEFORE splitting means a 40 MB file never becomes a
// million strings in memory on a machine whose job is somebody else's work.
func Read(root *os.Root, name string) protocol.FsFile {
	file := protocol.NewFsFile()
	file.Path = name

	handle, err := open(root, name)
	if err != nil {
		return failedFile(file, err)
	}
	defer handle.Close()

	info, err := handle.Stat()
	if err != nil {
		return failedFile(file, err)
	}
	if info.IsDir() {
		return failedFile(file, errors.New("is a directory"))
	}
	file.Bytes = int(info.Size())

	// One byte past the cap, so "was there more" is answered by the read itself
	// rather than trusting a size that may have changed since the stat.
	raw, err := io.ReadAll(io.LimitReader(handle, DefaultMaxBytes+1))
	if err != nil {
		return failedFile(file, err)
	}
	if isBinary(raw) {
		// ⚠ "binary" IS AN ANSWER, NOT A FAILURE — the same one `GitBlob` gives.
		file.Binary = true
		return file
	}
	if len(raw) > DefaultMaxBytes {
		raw = raw[:DefaultMaxBytes]
		file.Truncated = true
	}

	lines := strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
	if len(lines) > DefaultMaxLines {
		lines = lines[:DefaultMaxLines]
		file.Truncated = true
	}
	for i, line := range lines {
		line = strings.TrimRight(line, "\r")
		if len(line) > DefaultLineCap {
			line = line[:DefaultLineCap]
			file.Truncated = true
		}
		lines[i] = line
	}
	file.Lines = lines
	return file
}

// Chunk returns one slice of a file, addressed by byte offset.
//
// ⚠ IT IS A SEPARATE ENTRY POINT FROM `Read`, NOT A FLAG ON IT, because the two
// answer different questions. `Read` produces LINES for a viewer and reports
// binary content as a fact instead of sending it; this produces BYTES for a
// download or an image, and has no opinion about what is in them. Folding them
// together would mean one function whose caps, truncation and binary handling
// all depend on a mode — which is how the caller ends up getting lines it cannot
// use, or bytes it never asked for.
//
// ⚠ NOTHING IS HELD BETWEEN CALLS. The handle is opened and closed inside this
// function, so a download that stops halfway leaves nothing behind on the host —
// no session, no open file, nothing to time out. Resuming is asking for the next
// offset, which is also what makes an HTTP `Range` request answerable without
// reading the bytes in front of it.
func Chunk(root *os.Root, name string, offset int64, length int) protocol.FsChunk {
	chunk := protocol.NewFsChunk()
	chunk.Path = name
	chunk.Offset = int(offset)

	if offset < 0 {
		return failedChunk(chunk, errors.New("negative offset"))
	}
	if length <= 0 || length > DefaultChunkBytes {
		length = DefaultChunkBytes
	}

	handle, err := open(root, name)
	if err != nil {
		return failedChunk(chunk, err)
	}
	defer handle.Close()

	info, err := handle.Stat()
	if err != nil {
		return failedChunk(chunk, err)
	}
	if info.IsDir() {
		return failedChunk(chunk, errors.New("is a directory"))
	}
	chunk.Size = int(info.Size())

	// Past the end is not an error: a caller that asked for the offset after the
	// last byte has finished, and saying so is the answer it needs.
	if offset >= info.Size() {
		chunk.EOF = true
		return chunk
	}

	raw := make([]byte, length)
	read, err := handle.ReadAt(raw, offset)
	// ⚠ `io.EOF` FROM `ReadAt` IS NORMAL AND MEANS "this was the last slice". It
	// arrives together with the bytes, so returning early on it would throw away
	// the tail of every file whose size is not a multiple of the chunk.
	if err != nil && !errors.Is(err, io.EOF) {
		return failedChunk(chunk, err)
	}
	chunk.Data = base64.StdEncoding.EncodeToString(raw[:read])
	chunk.EOF = offset+int64(read) >= info.Size()
	return chunk
}

// Write puts one slice of bytes into a file, at an offset.
//
// ⚠ THE FENCE IS STILL THE HANDLE. `root.OpenFile` resolves the name inside the
// home exactly as a read does, so a write cannot land outside it — and, as
// everywhere in this package, there is no path check to get wrong.
//
// ⚠ `create` TRUNCATES, AND ONLY THE FIRST SLICE SETS IT. An upload is a series
// of requests with nothing held between them, so "start this file" has to be a
// flag on one of them rather than a session. Sending it on every slice would make
// a resumed upload silently produce a file containing only its last megabyte.
//
// ⚠ THE MODE IS 0600 ON CREATION. A file arriving from a browser is not something
// to hand the rest of the machine by default; the person can widen it from the
// terminal beside the panel, which is the direction that needs a deliberate act.
func Write(root *os.Root, name string, offset int64, data []byte, create bool) protocol.FsWrote {
	wrote := protocol.NewFsWrote()
	wrote.Path = name

	if offset < 0 {
		return failedWrote(wrote, errors.New("negative offset"))
	}
	if len(data) > DefaultChunkBytes {
		return failedWrote(wrote, errors.New("slice too large"))
	}
	clean, err := cleanName(name)
	if err != nil {
		return failedWrote(wrote, err)
	}

	flags := os.O_WRONLY | os.O_CREATE
	if create {
		flags |= os.O_TRUNC
	}
	handle, err := root.OpenFile(clean, flags, 0o600)
	if err != nil {
		return failedWrote(wrote, err)
	}
	defer handle.Close()

	written, err := handle.WriteAt(data, offset)
	wrote.Written = written
	if err != nil {
		return failedWrote(wrote, err)
	}
	info, err := handle.Stat()
	if err != nil {
		return failedWrote(wrote, err)
	}
	wrote.Size = int(info.Size())
	return wrote
}

// Remove deletes one entry under the home.
//
// ⚠ A NON-EMPTY DIRECTORY IS REFUSED UNLESS `recursive` SAYS OTHERWISE, and that
// refusal is the feature. "Delete this folder" and "delete this folder and the
// 4,000 things inside it" are different sentences, and the screen can only ask
// the second one honestly if the first cannot silently do it.
//
// ⚠ THE ROOT ITSELF IS NOT DELETABLE. An empty path means the home directory, and
// nothing in this product may remove somebody's home — so it is refused before
// anything else looks at it.
func Remove(root *os.Root, name string, recursive bool) protocol.FsRemoved {
	removed := protocol.NewFsRemoved()
	removed.Path = name

	clean, err := cleanName(name)
	if err != nil {
		return failedRemoved(removed, err)
	}
	if clean == "." {
		return failedRemoved(removed, errors.New("refusing to remove the home directory"))
	}

	info, err := root.Lstat(clean)
	if err != nil {
		return failedRemoved(removed, err)
	}
	// A symlink is unlinked as a link — never followed. Following one would delete
	// whatever it points at, which is the one place `os.Root`'s guarantee would not
	// help: the link itself is inside the home.
	if info.IsDir() && recursive {
		count, err := removeTree(root, clean)
		removed.Removed = count
		if err != nil {
			return failedRemoved(removed, err)
		}
		return removed
	}
	if err := root.Remove(clean); err != nil {
		return failedRemoved(removed, err)
	}
	removed.Removed = 1
	return removed
}

// removeTree deletes a directory's contents depth-first, through the handle.
//
// ⚠ IT WALKS WITH THE ROOT, NOT WITH `os.RemoveAll`. That function takes a
// filesystem path and would step outside the handle the moment a name resolved
// somewhere unexpected — the whole reason this package never builds a path.
func removeTree(root *os.Root, name string) (int, error) {
	handle, err := root.Open(name)
	if err != nil {
		return 0, err
	}
	entries, err := handle.ReadDir(-1)
	handle.Close()
	if err != nil {
		return 0, err
	}
	count := 0
	for _, entry := range entries {
		child := path.Join(name, entry.Name())
		if entry.IsDir() {
			nested, err := removeTree(root, child)
			count += nested
			if err != nil {
				return count, err
			}
			continue
		}
		if err := root.Remove(child); err != nil {
			return count, err
		}
		count++
	}
	if err := root.Remove(name); err != nil {
		return count, err
	}
	return count + 1, nil
}

// cleanName normalises a relative name and REFUSES one that leaves the home.
//
// ⚠ THIS IS NOT THE FENCE — `os.Root` is, and it would refuse these anyway. This
// is about being honest instead of helpful. The obvious spelling
// (`path.Clean("/" + name)`) folds `../escaped.txt` into `escaped.txt`, so a
// caller that asked for a place outside the home silently gets a DIFFERENT file
// inside it. Measured while writing the upload path: `Write(root,
// "../escaped.txt", …)` created `~/escaped.txt` and reported success. Reading was
// no better; it only looked safe because the reinterpreted name rarely exists.
//
// So an escaping or absolute name is an error. The contract says every path is
// relative to the home (`docs/CONTRACTS.md` §C6-3); a caller sending anything
// else is broken, and telling it so is more useful than guessing what it meant.
func cleanName(name string) (string, error) {
	trimmed := strings.TrimSpace(name)
	if len(trimmed) > defaultMaxPathLen {
		return "", errors.New("path too long")
	}
	if path.IsAbs(trimmed) || strings.HasPrefix(trimmed, "~") {
		return "", errors.New("path must be relative to the home directory")
	}
	clean := path.Clean(trimmed)
	if clean == "" {
		clean = "."
	}
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return "", errors.New("path leaves the home directory")
	}
	return clean, nil
}

// open resolves one name through the root handle.
//
// ⚠ THE ONLY NORMALISATION IS `path.Clean`, AND IT IS NOT THE FENCE. The fence
// is `os.Root`, which refuses to leave the directory whatever the name says.
// Cleaning is so the path that comes back in the frame reads the way the caller
// wrote it; `.` becomes the empty root because that is how the contract spells
// the home directory.
func open(root *os.Root, name string) (*os.File, error) {
	clean, err := cleanName(name)
	if err != nil {
		return nil, err
	}
	return root.Open(clean)
}

func isBinary(content []byte) bool {
	window := content
	if len(window) > binarySniffBytes {
		window = window[:binarySniffBytes]
	}
	// A NUL in the first 8 KB — git's own test, and the same window it uses.
	for _, b := range window {
		if b == 0 {
			return true
		}
	}
	return false
}

// failedDir and failedFile put the reason in the frame rather than dropping it.
//
// ⚠ A FAILURE TRAVELS IN THE FRAME, for the reason `git/tree.go` records: a
// directory this account cannot read is a fact the screen has to be able to
// state, and sending nothing leaves it looking like the click was lost. EACCES
// in particular is not an error in this product — it is the operating system
// answering the question correctly.
func failedDir(dir protocol.FsDir, err error) protocol.FsDir {
	message := reason(err)
	dir.Error = &message
	return dir
}

func failedChunk(chunk protocol.FsChunk, err error) protocol.FsChunk {
	message := reason(err)
	chunk.Error = &message
	return chunk
}

func failedWrote(wrote protocol.FsWrote, err error) protocol.FsWrote {
	message := reason(err)
	wrote.Error = &message
	return wrote
}

func failedRemoved(removed protocol.FsRemoved, err error) protocol.FsRemoved {
	message := reason(err)
	removed.Error = &message
	return removed
}

func failedFile(file protocol.FsFile, err error) protocol.FsFile {
	message := reason(err)
	file.Error = &message
	return file
}

func reason(err error) string {
	message := err.Error()
	if len(message) > 512 {
		message = message[:512]
	}
	return message
}
