package git

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

func TestStatusParsing(t *testing.T) {
	t.Run("[TC-PDAGENT-021] reads porcelain v2 records, renames included", func(t *testing.T) {
		text := strings.Join([]string{
			"1 M. N... 100644 100644 100644 aaa bbb src/kept.ts",
			"2 R. N... 100644 100644 100644 ccc ddd R100 src/new name.ts\tsrc/old.ts",
			"u UU N... 100644 100644 100644 100644 eee fff ggg src/conflict.ts",
			"? untracked one.txt",
		}, "\n")
		parsed := ParsePorcelainV2(text, 0)
		if parsed.Staged != 2 || parsed.Unstaged != 0 || parsed.Untracked != 1 || parsed.Conflicts != 1 || parsed.Total != 4 {
			t.Fatalf("counts = %+v", parsed)
		}
		want := []string{"src/kept.ts", "src/new name.ts", "src/conflict.ts", "untracked one.txt"}
		got := []string{}
		for _, file := range parsed.Files {
			got = append(got, file.Path)
		}
		if !equalStrings(got, want) {
			t.Fatalf("paths = %v, want %v", got, want)
		}
	})

	t.Run("[TC-PDAGENT-021] never emits an empty index/worktree letter", func(t *testing.T) {
		// The letters default to a SPACE, not to "". The contract only caps their
		// LENGTH, so an empty string is accepted and stored as a letter that means
		// nothing — with no error raised anywhere. A malformed one-character XY
		// field is the case that produces it if the fallback is wrong.
		parsed := ParsePorcelainV2("1 M N... 100644 100644 100644 aaa bbb short.ts", 0)
		if len(parsed.Files) != 1 {
			t.Fatalf("files = %+v", parsed.Files)
		}
		if parsed.Files[0].X == "" || parsed.Files[0].Y == "" {
			t.Fatalf("letters = %q/%q, want non-empty", parsed.Files[0].X, parsed.Files[0].Y)
		}
		encoded, err := json.Marshal(parsed)
		if err != nil {
			t.Fatal(err)
		}
		for _, forbidden := range []string{`"x":""`, `"y":""`} {
			if strings.Contains(string(encoded), forbidden) {
				t.Fatalf("status carried %s: %s", forbidden, encoded)
			}
		}
	})

	t.Run("[TC-PDAGENT-021] counts what the file cap left out", func(t *testing.T) {
		lines := []string{}
		for index := 0; index < 10; index++ {
			lines = append(lines, "? file-"+string(rune('0'+index))+".txt")
		}
		parsed := ParsePorcelainV2(strings.Join(lines, "\n"), 4)
		if len(parsed.Files) != 4 {
			t.Fatalf("files = %d, want the cap of 4", len(parsed.Files))
		}
		if parsed.Dropped != 6 {
			t.Fatalf("dropped = %d, want 6", parsed.Dropped)
		}
		// The COUNTS stay honest even though the list does not: ten files are
		// untracked whether or not the list carries them.
		if parsed.Untracked != 10 {
			t.Fatalf("untracked = %d, want 10", parsed.Untracked)
		}
	})
}

func TestBranchAndSubmoduleState(t *testing.T) {
	t.Run("[TC-PDAGENT-040] flags a branch whose upstream was deleted", func(t *testing.T) {
		if got := ParseTrack("[ahead 2, behind 1]"); got != (Track{Ahead: 2, Behind: 1}) {
			t.Fatalf("track = %+v", got)
		}
		if got := ParseTrack("[gone]"); got != (Track{Gone: true}) {
			t.Fatalf("track = %+v", got)
		}
		line := strings.Join([]string{
			"refs/heads/feat/x",
			strings.Repeat("a", 40),
			"origin/feat/x",
			"[gone]",
		}, FieldSep)
		refs := ParseRefBlock(line, "refs/heads/", protocol.GitRefLocal)
		if len(refs) != 1 {
			t.Fatalf("refs = %+v", refs)
		}
		if refs[0].Name != "feat/x" {
			t.Fatalf("name = %q", refs[0].Name)
		}
		if refs[0].Upstream == nil || *refs[0].Upstream != "origin/feat/x" {
			t.Fatalf("upstream = %v", refs[0].Upstream)
		}
		if !refs[0].Gone {
			t.Fatal("a deleted upstream must be flagged: 'behind 0' is meaningless there")
		}
	})

	t.Run("[TC-PDAGENT-021] drops origin/HEAD and applies the ref cap", func(t *testing.T) {
		// `origin/HEAD` is a symbolic pointer, not a branch anybody can check out.
		text := strings.Join([]string{
			strings.Join([]string{"refs/remotes/origin/HEAD", strings.Repeat("a", 40), "", ""}, FieldSep),
			strings.Join([]string{"refs/remotes/origin/main", strings.Repeat("b", 40), "", ""}, FieldSep),
		}, "\n")
		refs := ParseRefBlock(text, "refs/remotes/", protocol.GitRefRemote)
		if len(refs) != 1 || refs[0].Name != "origin/main" {
			t.Fatalf("refs = %+v", refs)
		}
		// A remote-tracking ref tracks nothing itself; leaving the counts null says so.
		if refs[0].Upstream != nil || refs[0].Ahead != nil || refs[0].Behind != nil {
			t.Fatalf("a remote ref carried tracking data: %+v", refs[0])
		}
	})

	t.Run("[TC-PDAGENT-041] counts submodule pointers that moved", func(t *testing.T) {
		text := strings.Join([]string{
			"1 .M S.M. 160000 160000 160000 aaa bbb vendor/lib",
			"1 .M N... 100644 100644 100644 ccc ddd src/app.ts",
			"1 .M SC.. 160000 160000 160000 eee fff vendor/other",
		}, "\n")
		parsed := ParsePorcelainV2(text, 0)
		if parsed.Submodules != 2 {
			t.Fatalf("submodules = %d, want 2", parsed.Submodules)
		}
		if parsed.Unstaged != 3 {
			t.Fatalf("unstaged = %d, want 3", parsed.Unstaged)
		}
	})

	t.Run("[TC-PDAGENT-041] does not count a clean submodule as dirty", func(t *testing.T) {
		parsed := ParsePorcelainV2("1 .M S... 160000 160000 160000 aaa bbb vendor/lib", 0)
		if parsed.Submodules != 0 {
			t.Fatalf("submodules = %d, want 0 for the all-clean S... field", parsed.Submodules)
		}
	})

	t.Run("[TC-PDAGENT-021] reads the ahead/behind counts in the order rev-list prints them", func(t *testing.T) {
		// `rev-list --left-right --count <upstream>...HEAD` prints LEFT then RIGHT:
		// the upstream's exclusive commits (behind) before HEAD's own (ahead).
		got := ParseAheadBehind("3\t5\n")
		if got.Behind == nil || *got.Behind != 3 || got.Ahead == nil || *got.Ahead != 5 {
			t.Fatalf("ahead/behind = %v/%v", got.Ahead, got.Behind)
		}
		// Unparseable output leaves BOTH null: a zero here would claim the branch
		// is up to date with a remote nobody managed to compare against.
		for _, bad := range []string{"", "3", "3 4 5", "three four"} {
			if got := ParseAheadBehind(bad); got.Ahead != nil || got.Behind != nil {
				t.Fatalf("ParseAheadBehind(%q) = %v/%v, want null/null", bad, got.Ahead, got.Behind)
			}
		}
	})
}

func TestDiffCaps(t *testing.T) {
	t.Run("[TC-PDAGENT-025] clips a single very long line and flags the file", func(t *testing.T) {
		// A line cap alone is not enough: lock files and bundles have single lines
		// thousands of characters long, and one such commit produced a 4.1MB
		// payload while staying under the 800-line limit.
		long := "+" + strings.Repeat("x", 3_000)
		files := SplitPatch(strings.Join([]string{
			"diff --git a/lock.json b/lock.json",
			"@@ -1 +1 @@",
			long,
		}, "\n"))
		if len(files) != 1 || len(files[0].Lines) != 2 {
			t.Fatalf("files = %+v", files)
		}
		// The clip appends " …", so the cap plus those two characters is the bound.
		if got := utf8.RuneCountInString(files[0].Lines[1]); got > protocol.DiffCapsMaxLineChars+2 {
			t.Fatalf("clipped line is %d characters, want <= %d", got, protocol.DiffCapsMaxLineChars+2)
		}
		if !files[0].Truncated {
			t.Fatal("a clipped file must say so")
		}
	})

	t.Run("[TC-PDAGENT-025] stops after the per-file line cap", func(t *testing.T) {
		lines := []string{"diff --git a/big.ts b/big.ts", "@@ -0,0 +1 @@"}
		for index := 0; index < protocol.DiffCapsMaxFileLines+50; index++ {
			lines = append(lines, "+line")
		}
		files := SplitPatch(strings.Join(lines, "\n"))
		if len(files[0].Lines) > protocol.DiffCapsMaxFileLines {
			t.Fatalf("lines = %d, want <= %d", len(files[0].Lines), protocol.DiffCapsMaxFileLines)
		}
		if !files[0].Truncated {
			t.Fatal("a file cut by the line cap must say so")
		}
		// The COUNTS describe the whole file even when the lines do not — a UI
		// that says "+850" next to 800 rendered lines is telling the truth.
		if files[0].Add != protocol.DiffCapsMaxFileLines+50 {
			t.Fatalf("add = %d, want %d", files[0].Add, protocol.DiffCapsMaxFileLines+50)
		}
	})

	t.Run("[TC-PDAGENT-025] drops later files once the whole-diff byte cap is spent", func(t *testing.T) {
		heavy := func(path string) string {
			lines := []string{"diff --git a/" + path + " b/" + path, "@@ -0,0 +1 @@"}
			for index := 0; index < 700; index++ {
				lines = append(lines, "+"+strings.Repeat("y", 400))
			}
			return strings.Join(lines, "\n")
		}
		files := SplitPatch(strings.Join([]string{heavy("one.ts"), heavy("two.ts"), heavy("three.ts")}, "\n"))
		capped, dropped := CapFiles(files)

		bytes := 0
		for _, file := range capped {
			for _, line := range file.Lines {
				bytes += len(line) + 1
			}
		}
		if bytes > protocol.DiffCapsMaxBytes+protocol.DiffCapsMaxLineChars {
			t.Fatalf("kept %d bytes, want at most the cap plus one line", bytes)
		}
		if dropped == 0 {
			t.Fatal("later files must be dropped WITH a count so the UI can say how many are missing")
		}
		// The first file is trimmed rather than dropped: the beginning of a big
		// change is still worth seeing.
		if len(capped) == 0 || !capped[0].Truncated || len(capped[0].Lines) == 0 {
			t.Fatalf("first file = %+v, want a trimmed but present patch", capped)
		}
	})

	t.Run("[TC-PDAGENT-025] marks a binary file instead of shipping its bytes", func(t *testing.T) {
		files := SplitPatch(strings.Join([]string{
			"diff --git a/logo.png b/logo.png",
			"Binary files a/logo.png and b/logo.png differ",
		}, "\n"))
		if len(files) != 1 || !files[0].Binary {
			t.Fatalf("files = %+v", files)
		}
		if len(files[0].Lines) != 0 {
			t.Fatalf("a binary file carried %d lines", len(files[0].Lines))
		}
	})

	// UNTAGGED: the TypeScript suite never asserted rename detection in the PATCH
	// parser (only in porcelain v2 status), so there is no TC to reuse.
	t.Run("records a rename with the path it had before", func(t *testing.T) {
		files := SplitPatch(strings.Join([]string{
			"diff --git a/src/old.ts b/src/new.ts",
			"similarity index 96%",
			"rename from src/old.ts",
			"rename to src/new.ts",
		}, "\n"))
		if len(files) != 1 {
			t.Fatalf("files = %+v", files)
		}
		if files[0].Path != "src/new.ts" {
			t.Fatalf("path = %q, want the b-side (what the file is now)", files[0].Path)
		}
		if files[0].OldPath == nil || *files[0].OldPath != "src/old.ts" {
			t.Fatalf("oldPath = %v", files[0].OldPath)
		}
		if files[0].Status != protocol.DiffRenamed {
			t.Fatalf("status = %q, want R", files[0].Status)
		}
	})
}

func TestCommitLogParsing(t *testing.T) {
	t.Run("[TC-PDAGENT-023] splits rows from bodies and marks a clipped body", func(t *testing.T) {
		chunk := strings.Join([]string{
			strings.Repeat("a", 40),
			strings.Repeat("b", 40) + " " + strings.Repeat("c", 40),
			"HEAD -> main, tag: v1.0.0",
			"A Developer",
			"1784000000",
			"feat: something",
			"\n\nthe body\n\n",
		}, FieldSep)
		parsed := ParseLog(RecordSep+chunk, 100, 4)
		if len(parsed.Commits) != 1 {
			t.Fatalf("commits = %+v", parsed.Commits)
		}
		commit := parsed.Commits[0]
		if len(commit.Parents) != 2 {
			t.Fatalf("parents = %v", commit.Parents)
		}
		if !equalStrings(commit.Refs, []string{"HEAD -> main", "tag: v1.0.0"}) {
			t.Fatalf("refs = %v", commit.Refs)
		}
		if commit.Date == nil || *commit.Date != 1784000000 {
			t.Fatalf("date = %v", commit.Date)
		}
		body := parsed.Bodies[commit.Sha]
		if body.Body != "the " || !body.BodyTruncated {
			t.Fatalf("body = %q truncated=%v", body.Body, body.BodyTruncated)
		}
		// The window was not filled, so older history is not hidden.
		if parsed.Truncated {
			t.Fatal("one commit did not fill a 100-commit window")
		}
	})

	t.Run("[TC-PDAGENT-021] leaves an unreadable author date null rather than zero", func(t *testing.T) {
		chunk := strings.Join([]string{
			strings.Repeat("a", 40), "", "", "A Developer", "not-a-date", "subject", "",
		}, FieldSep)
		parsed := ParseLog(RecordSep+chunk, 100, 0)
		if len(parsed.Commits) != 1 {
			t.Fatalf("commits = %+v", parsed.Commits)
		}
		// Zero would be 1970 on the graph, which is a claim rather than a gap.
		if parsed.Commits[0].Date != nil {
			t.Fatalf("date = %v, want null", *parsed.Commits[0].Date)
		}
		// Slices are never nil: `null` fails the contract and drops the frame.
		if parsed.Commits[0].Parents == nil || parsed.Commits[0].Refs == nil {
			t.Fatalf("nil slice in %+v", parsed.Commits[0])
		}
	})

	t.Run("[TC-PDAGENT-039] accepts only plain hex as a sha", func(t *testing.T) {
		for _, good := range []string{"abcdef1", strings.Repeat("0", 40), "ABCDEF1234567"} {
			if !IsSha(good) {
				t.Fatalf("IsSha(%q) = false", good)
			}
		}
		for _, bad := range []string{
			"", "abcdef", strings.Repeat("a", 41),
			"--upload-pack=x", "--output=/tmp/pwned", "zzzzzzz", "HEAD", "-abcdef1",
		} {
			if IsSha(bad) {
				t.Fatalf("IsSha(%q) = true; that string would become git argv", bad)
			}
		}
	})
}
