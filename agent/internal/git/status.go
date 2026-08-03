package git

import (
	"context"
	"strings"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// StatusFileCap bounds the file list one snapshot carries. The server can lower
// it; what it may not do is make a truncated list read as complete, which is
// what the `dropped` counter is for.
const StatusFileCap = 300

// ParsePorcelainV2 reads `git status --porcelain=v2`.
//
// v2 rather than v1 because the machine-readable format is stable and carries
// the index/worktree letters separately, which is what a UI needs to tell
// "staged" from "modified in the tree".
//
// fileCap <= 0 means StatusFileCap.
func ParsePorcelainV2(text string, fileCap int) protocol.GitUncommitted {
	if fileCap <= 0 {
		fileCap = StatusFileCap
	}
	result := protocol.NewGitUncommitted()

	for _, line := range strings.Split(text, "\n") {
		if line == "" {
			continue
		}
		var (
			path  string
			x, y  string
			entry bool
		)
		switch {
		case strings.HasPrefix(line, "1 "), strings.HasPrefix(line, "2 "):
			// 1 XY sub mH mI mW hH hI <path>
			// 2 XY sub mH mI mW hH hI <X><score> <path>\t<origPath>   (rename/copy)
			bits := strings.Split(line, " ")
			xy := field(bits, 1)
			if xy == "" {
				xy = ".."
			}
			// porcelain v2 spells "unchanged" as `.`, which is what an absent
			// letter has to fall back to — never "", which passes the contract's
			// max(1) check and is then stored as a letter that means nothing.
			x = charAt(xy, 0, ".")
			y = charAt(xy, 1, ".")

			firstPathField := 8
			if strings.HasPrefix(line, "2 ") {
				firstPathField = 9
			}
			// Split-then-join round-trips a path containing spaces; a rename record
			// carries `<new>\t<old>` and the new path is what exists now.
			rest := strings.Join(bits[min(firstPathField, len(bits)):], " ")
			path, _, _ = strings.Cut(rest, "\t")
			if path == "" {
				continue
			}
			if x != "." {
				result.Staged++
			}
			if y != "." {
				result.Unstaged++
			}
			// The `sub` field is `N...` for an ordinary path and `S<c><m><u>` for a
			// submodule; anything past the all-clean `S...` means the pointer moved
			// or the submodule tree is dirty. Counted separately because a dirty
			// submodule shows nothing in the file list yet is exactly what makes a
			// "clean" checkout commit something unexpected.
			if sub := field(bits, 2); strings.HasPrefix(sub, "S") && sub != "S..." {
				result.Submodules++
			}
			entry = true

		case strings.HasPrefix(line, "u "):
			bits := strings.Split(line, " ")
			path = strings.Join(bits[min(10, len(bits)):], " ")
			result.Conflicts++
			x, y = "U", "U"
			entry = true

		case strings.HasPrefix(line, "? "):
			path = sliceFrom(line, 2)
			result.Untracked++
			x, y = "?", "?"
			entry = true
		}

		if !entry {
			continue
		}
		if len(result.Files) < fileCap {
			file := protocol.NewGitStatusFile()
			file.Path = path
			// Assigned only when non-empty: the constructor seeds a SPACE, and an
			// empty letter would be accepted by the contract and stored as a
			// meaning that does not exist.
			if x != "" {
				file.X = x
			}
			if y != "" {
				file.Y = y
			}
			result.Files = append(result.Files, file)
		} else {
			// A truncated list must never read as complete, so the remainder is counted.
			result.Dropped++
		}
	}

	result.Total = result.Staged + result.Unstaged + result.Untracked + result.Conflicts
	return result
}

// ReadStatus summarises uncommitted work.
//
// A nil return means the status could not be READ. That is deliberately not the
// same as an empty struct, which means it was read and the tree is clean —
// collapsing the two reports every broken checkout as clean.
func ReadStatus(ctx context.Context, git Runner, fileCap int) (*protocol.GitUncommitted, error) {
	text, err := git(ctx,
		// `--untracked-files=all` lists files inside untracked directories too; a
		// collapsed `dir/` entry hides how much work is actually sitting there.
		[]string{"status", "--porcelain=v2", "--untracked-files=all"},
		CallOptions{TimeoutMs: 30_000},
	)
	if err != nil {
		return nil, ignoreFailure(err)
	}
	status := ParsePorcelainV2(text, fileCap)
	return &status, nil
}
