package git

import (
	"context"
	"strings"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// UntrackedFileCap bounds how many untracked files get a patch of their own.
// Each one costs a separate `git diff --no-index`, and a freshly unpacked
// tarball in a working tree would otherwise cost hundreds.
const UntrackedFileCap = 50

// minRoom is the smallest slice of the byte budget worth spending on a file.
//
// It appears twice in capFiles for two different reasons: a file is trimmed
// rather than dropped only while at least this much room is left, and the FIRST
// file always gets at least this much even when the budget is already spent.
// The beginning of a big change is still worth seeing.
const minRoom = 4096

const diffGitHeader = "diff --git a/"

// SplitPatch parses unified-diff text into per-file patches, applying the two
// per-file caps as it goes.
//
// Parsed HERE rather than in the page: the UI should render, not interpret git
// output, and the caps have to be applied before anything crosses the wire.
//
// ⚠ A LINE CAP ALONE IS NOT ENOUGH. Lock files and bundles have single lines
// thousands of characters long — one such commit produced a 4.1MB payload while
// staying under the 800-line limit. Hence three caps: bytes for the whole diff
// (capFiles), lines per file and characters per line (here).
func SplitPatch(text string) []protocol.DiffFile {
	files := []protocol.DiffFile{}
	var current *protocol.DiffFile

	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "diff --git ") {
			if current != nil {
				files = append(files, *current)
			}
			// `diff --git a/<old> b/<new>` — the b-side is what the file is now. A
			// path that itself contains " b/" splits into more than two pieces, and
			// then the whole header is treated as one path rather than guessed at.
			parts := strings.Split(line, " b/")
			var path, old string
			if len(parts) == 2 {
				path = parts[1]
				old = sliceFrom(parts[0], len(diffGitHeader))
			} else {
				path = sliceFrom(line, len(diffGitHeader))
				old = path
			}
			file := protocol.NewDiffFile()
			file.Path = path
			if old != path {
				file.OldPath = &old
			}
			file.Status = protocol.DiffModified
			current = &file
			continue
		}
		if current == nil {
			continue
		}

		switch {
		case strings.HasPrefix(line, "new file"):
			current.Status = protocol.DiffAdded
		case strings.HasPrefix(line, "deleted file"):
			current.Status = protocol.DiffDeleted
		case strings.HasPrefix(line, "rename from"), strings.HasPrefix(line, "rename to"):
			current.Status = protocol.DiffRenamed
		case strings.HasPrefix(line, "Binary files"):
			// Marked, never carried: the bytes are useless in a browser and would
			// be the largest thing in the frame.
			current.Binary = true
		case strings.HasPrefix(line, "@@"),
			strings.HasPrefix(line, "+"),
			strings.HasPrefix(line, "-"),
			strings.HasPrefix(line, " "):
			// `+++ b/x` and `--- a/x` are file headers, not content.
			if strings.HasPrefix(line, "+++") || strings.HasPrefix(line, "---") {
				continue
			}
			// Counted before the caps, so add/del stay TRUE for the whole file even
			// when only the first 800 lines travel.
			if strings.HasPrefix(line, "+") {
				current.Add++
			} else if strings.HasPrefix(line, "-") {
				current.Del++
			}
			if len(current.Lines) >= protocol.DiffCapsMaxFileLines {
				current.Truncated = true
				continue
			}
			if tooLong(line, protocol.DiffCapsMaxLineChars) {
				current.Lines = append(current.Lines, clip(line, protocol.DiffCapsMaxLineChars)+" …")
				current.Truncated = true
				continue
			}
			current.Lines = append(current.Lines, line)
		}
	}
	if current != nil {
		files = append(files, *current)
	}
	return files
}

// CapFiles applies the whole-diff byte cap, file by file so the FIRST files stay
// complete. A single file larger than the whole budget is trimmed rather than
// dropped, and later files are dropped with a count so the UI can say how many
// are missing.
//
// The budget is measured in BYTES here, which is what `maxBytes` names and what
// actually crosses the socket. (The TypeScript measured UTF-16 code units for
// both this cap and the per-line one, because JavaScript has no other length;
// for a diff full of non-ASCII the two disagree, and the byte count is the one
// that describes the frame.)
func CapFiles(files []protocol.DiffFile) (kept []protocol.DiffFile, dropped int) {
	out := []protocol.DiffFile{}
	total := 0
	for _, file := range files {
		size := 0
		for _, line := range file.Lines {
			size += len(line) + 1 // +1 for the newline that rejoins them
		}
		room := protocol.DiffCapsMaxBytes - total
		if size <= room {
			total += size
			out = append(out, file)
			continue
		}
		if len(out) > 0 && room <= minRoom {
			dropped++
			continue
		}
		budget := max(room, minRoom)
		lines := []string{}
		used := 0
		for _, line := range file.Lines {
			if used+len(line)+1 > budget {
				break
			}
			lines = append(lines, line)
			used += len(line) + 1
		}
		// `file` is a copy of the element, so trimming it here cannot corrupt the
		// caller's slice — the TypeScript mutated the objects in place.
		file.Lines = lines
		file.Truncated = true
		total += used
		out = append(out, file)
	}
	return out, dropped
}

// CommitPatch is one commit's parsed patch.
type CommitPatch struct {
	Files     []protocol.DiffFile
	Dropped   int
	Truncated bool
	// Empty records that the commit shows no patch at all (see ReadCommitPatch).
	Empty bool
}

// ReadCommitPatch reads one commit as a parsed patch.
//
// `-m --first-parent` so a merge shows the change it actually brought in. Many
// merges still produce NOTHING against their first parent — that emptiness is a
// result and gets recorded, otherwise every pass recomputes it forever and the
// per-pass budget is spent on merges that will never have a patch.
func ReadCommitPatch(ctx context.Context, git Runner, sha string) (CommitPatch, error) {
	text, err := git(ctx, []string{
		"show", sha,
		"--format=", // rows carry the metadata; this call is only after the patch
		"--patch",
		"--no-color",
		"-m", "--first-parent",
		"--find-renames",
	}, CallOptions{TimeoutMs: 40_000})
	if err != nil {
		return CommitPatch{Files: []protocol.DiffFile{}, Empty: true}, ignoreFailure(err)
	}
	files, dropped := CapFiles(SplitPatch(text))
	truncated := dropped > 0
	for _, file := range files {
		if file.Truncated {
			truncated = true
			break
		}
	}
	return CommitPatch{Files: files, Dropped: dropped, Truncated: truncated, Empty: len(files) == 0}, nil
}

// ReadWorkingDiff reads staged, unstaged and untracked content as one
// working-tree patch. status may be nil, which simply means no untracked file
// gets a patch.
func ReadWorkingDiff(ctx context.Context, git Runner, status *protocol.GitUncommitted) (protocol.WorkingDiff, error) {
	out := protocol.NewWorkingDiff()

	for _, part := range []struct {
		Into *[]protocol.DiffFile
		Args []string
	}{
		{&out.Staged, []string{"diff", "--cached"}},
		{&out.Unstaged, []string{"diff"}},
	} {
		args := append(append([]string{}, part.Args...), "--no-color", "--find-renames")
		text, err := absorb(git(ctx, args, CallOptions{TimeoutMs: 40_000}))
		if err != nil {
			return out, err
		}
		files, dropped := CapFiles(SplitPatch(text))
		*part.Into = files
		out.Dropped += dropped
	}

	if status != nil {
		for _, entry := range status.Files {
			if entry.X != "?" || len(out.Untracked) >= UntrackedFileCap {
				continue
			}
			// An untracked file has no diff of its own; `--no-index` against
			// /dev/null produces a real add-only patch and stays read-only.
			// ⚠ exit 1 means "they differ", which is the NORMAL result here.
			//
			// `--` before the paths: a file named `-rf` is a legal file and would
			// otherwise be parsed as options. Same reasoning as IsSha — these
			// strings become argv.
			text, err := absorb(git(ctx,
				[]string{"diff", "--no-index", "--no-color", "--", "/dev/null", entry.Path},
				CallOptions{TimeoutMs: 20_000, OK: []int{0, 1}},
			))
			if err != nil {
				return out, err
			}
			files, _ := CapFiles(SplitPatch(text))
			for _, file := range files {
				// The patch header names /dev/null on one side; the entry's own path
				// is the truthful one.
				file.Path = entry.Path
				file.Status = protocol.DiffAdded
				out.Untracked = append(out.Untracked, file)
			}
		}
	}

	out.Truncated = out.Dropped > 0
	if !out.Truncated {
		for _, group := range [][]protocol.DiffFile{out.Staged, out.Unstaged, out.Untracked} {
			for _, file := range group {
				if file.Truncated {
					out.Truncated = true
					break
				}
			}
		}
	}
	return out, nil
}
