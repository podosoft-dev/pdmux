package git

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

func repoOptions(fix fixture, budget int) SnapshotOptions {
	return SnapshotOptions{
		Path:         fix.Repo,
		Name:         "demo",
		Limit:        100,
		DetailBudget: budget,
		Ledger:       NewDetailLedger(0, nil),
	}
}

func TestRepositorySnapshot(t *testing.T) {
	fix := newFixture(t)
	ctx := context.Background()

	t.Run("[TC-PDAGENT-021] describes head, refs and the commit rows", func(t *testing.T) {
		snapshot := CollectRepoSnapshot(ctx, repoOptions(fix, 0))
		if snapshot.Error != nil {
			t.Fatalf("error = %q", *snapshot.Error)
		}
		if snapshot.Head.Branch == nil || *snapshot.Head.Branch != "main" {
			t.Fatalf("head.branch = %v", snapshot.Head.Branch)
		}
		if snapshot.Head.Detached {
			t.Fatal("a checkout on a branch is not detached")
		}
		if snapshot.Head.Sha == nil || len(*snapshot.Head.Sha) != 40 {
			t.Fatalf("head.sha = %v", snapshot.Head.Sha)
		}

		names := map[string]bool{}
		for _, ref := range snapshot.Refs {
			names[string(ref.Kind)+":"+ref.Name] = true
		}
		for _, want := range []string{"local:main", "local:feature", "tag:v0.1.0"} {
			if !names[want] {
				t.Fatalf("refs missing %s (got %v)", want, names)
			}
		}

		subjects := map[string]bool{}
		var merge *protocol.GitCommit
		for index, commit := range snapshot.Commits {
			subjects[commit.Subject] = true
			if commit.Sha == fix.MergeSha {
				merge = &snapshot.Commits[index]
			}
		}
		for _, want := range []string{"feat: add a", "feat: add c on feature", "chore: merge feature (ours)"} {
			if !subjects[want] {
				t.Fatalf("commits missing %q", want)
			}
		}
		if merge == nil || len(merge.Parents) != 2 {
			t.Fatalf("merge row = %+v, want two parents", merge)
		}
		if snapshot.Truncated {
			t.Fatal("a five-commit history did not fill a 100-commit window")
		}
		if snapshot.Limit != 100 {
			t.Fatalf("limit = %d", snapshot.Limit)
		}
	})

	t.Run("[TC-PDAGENT-021] counts staged, unstaged and untracked work", func(t *testing.T) {
		snapshot := CollectRepoSnapshot(ctx, repoOptions(fix, 0))
		status := snapshot.Uncommitted
		if status == nil {
			t.Fatal("uncommitted is nil, which means the status could not be READ")
		}
		if status.Staged != 1 || status.Unstaged != 1 || status.Untracked != 1 || status.Total != 3 {
			t.Fatalf("counts = %+v", *status)
		}
		paths := []string{}
		for _, file := range status.Files {
			paths = append(paths, file.Path)
		}
		want := []string{"a.txt", "staged.txt", "untracked.txt"}
		if got := sortedStrings(paths); !equalStrings(got, want) {
			t.Fatalf("files = %v, want %v", got, want)
		}
	})

	t.Run("[TC-PDAGENT-022] patches the working tree, untracked files included", func(t *testing.T) {
		snapshot := CollectRepoSnapshot(ctx, repoOptions(fix, 0))
		diff := snapshot.WorkingDiff
		if diff == nil {
			t.Fatal("a dirty tree must carry a working diff")
		}
		if got := paths(diff.Staged); !equalStrings(got, []string{"staged.txt"}) {
			t.Fatalf("staged = %v", got)
		}
		if got := paths(diff.Unstaged); !equalStrings(got, []string{"a.txt"}) {
			t.Fatalf("unstaged = %v", got)
		}
		// `git diff --no-index` exits 1 for "they differ" — treating that as
		// failure is what silently loses every untracked file.
		if got := paths(diff.Untracked); !equalStrings(got, []string{"untracked.txt"}) {
			t.Fatalf("untracked = %v", got)
		}
		if diff.Untracked[0].Status != protocol.DiffAdded {
			t.Fatalf("untracked status = %q, want A", diff.Untracked[0].Status)
		}
		if !strings.Contains(strings.Join(diff.Untracked[0].Lines, "\n"), "+untracked content") {
			t.Fatalf("untracked patch = %v", diff.Untracked[0].Lines)
		}
	})

	t.Run("[TC-PDAGENT-023] honours the per-pass detail budget and reports what is pending", func(t *testing.T) {
		ledger := NewDetailLedger(0, nil)
		options := repoOptions(fix, 2)
		options.Ledger = ledger

		first := CollectRepoSnapshot(ctx, options)
		if len(first.Details) != 2 {
			t.Fatalf("first pass produced %d details, want 2", len(first.Details))
		}
		if want := len(first.Commits) - 2; first.Pending != want {
			t.Fatalf("pending = %d, want %d", first.Pending, want)
		}
		// Newest first: the commits somebody is about to click arrive first.
		// The merge is the only commit in the fixture with no children, so
		// `--date-order` must emit it first whatever the second-resolution
		// timestamps do — which makes this an anchor rather than a tautology
		// against whatever order the rows happen to be in.
		if first.Commits[0].Sha != fix.MergeSha {
			t.Fatalf("rows do not start at the tip: %s", first.Commits[0].Sha)
		}
		if first.Details[0].Sha != first.Commits[0].Sha {
			t.Fatalf("first detail %s is not the newest commit %s", first.Details[0].Sha, first.Commits[0].Sha)
		}

		second := CollectRepoSnapshot(ctx, options)
		for _, detail := range second.Details {
			if detail.Sha == first.Details[0].Sha {
				t.Fatal("the second pass rebuilt a detail the first one already produced")
			}
		}
		if want := first.Pending - 2; second.Pending != want {
			t.Fatalf("pending = %d, want %d", second.Pending, want)
		}
	})

	t.Run("[TC-PDAGENT-023] carries the message body with the detail, not with the rows", func(t *testing.T) {
		snapshot := CollectRepoSnapshot(ctx, repoOptions(fix, 100))
		detail := findDetail(snapshot.Details, "feat: add a")
		if detail == nil {
			t.Fatal("no detail for 'feat: add a'")
		}
		if !strings.Contains(detail.Body, "A body line explaining why.") {
			t.Fatalf("detail body = %q", detail.Body)
		}
		if detail.BodyTruncated {
			t.Fatal("a one-line body is not truncated")
		}
		// The rows carry no body AT ALL — the Go struct has no such field, so the
		// check that matters at runtime is the wire shape the server receives.
		encoded, err := json.Marshal(snapshot.Commits[0])
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(encoded), `"body"`) {
			t.Fatalf("a commit row carried a body: %s", encoded)
		}
	})

	t.Run("[TC-PDAGENT-042] honours the server-configured body and status caps", func(t *testing.T) {
		options := repoOptions(fix, 100)
		options.BodyMaxChars = 10
		options.StatusFileCap = 1

		snapshot := CollectRepoSnapshot(ctx, options)
		detail := findDetail(snapshot.Details, "feat: add a")
		if detail == nil {
			t.Fatal("no detail for 'feat: add a'")
		}
		if detail.Body != "A body lin" {
			t.Fatalf("body = %q, want the first 10 characters", detail.Body)
		}
		if !detail.BodyTruncated {
			t.Fatal("a clipped body must say so")
		}
		if len(snapshot.Uncommitted.Files) != 1 {
			t.Fatalf("files = %d, want the configured cap of 1", len(snapshot.Uncommitted.Files))
		}
		// A truncated list must never read as complete.
		if snapshot.Uncommitted.Dropped != 2 {
			t.Fatalf("dropped = %d, want 2", snapshot.Uncommitted.Dropped)
		}
	})

	t.Run("[TC-PDAGENT-024] records an empty first-parent merge so it is not recomputed", func(t *testing.T) {
		ledger := NewDetailLedger(0, nil)
		options := repoOptions(fix, 100)
		options.Ledger = ledger

		first := CollectRepoSnapshot(ctx, options)
		var merge *protocol.CommitDetail
		for index, detail := range first.Details {
			if detail.Sha == fix.MergeSha {
				merge = &first.Details[index]
			}
		}
		if merge == nil {
			t.Fatal("the merge got no detail")
		}
		if !merge.Empty {
			t.Fatal("a merge with no first-parent patch must be recorded as empty")
		}
		if len(merge.Files) != 0 {
			t.Fatalf("empty merge carried %d files", len(merge.Files))
		}

		second := CollectRepoSnapshot(ctx, options)
		if len(second.Details) != 0 {
			t.Fatalf("the second pass rebuilt %d details; the empty merge is being recomputed forever", len(second.Details))
		}
		if second.Pending != 0 {
			t.Fatalf("pending = %d after every detail was produced", second.Pending)
		}
	})

	t.Run("[TC-PDAGENT-021] reports a broken checkout as an error instead of failing the pass", func(t *testing.T) {
		snapshot := CollectRepoSnapshot(ctx, SnapshotOptions{
			Path:         filepath.Join(fix.Root, "not-a-repo"),
			Name:         "ghost",
			Limit:        10,
			DetailBudget: 1,
			Ledger:       NewDetailLedger(0, nil),
		})
		if len(snapshot.Commits) != 0 {
			t.Fatalf("a non-repository produced %d commits", len(snapshot.Commits))
		}
		if snapshot.Head.Sha != nil {
			t.Fatalf("head.sha = %v, want null", *snapshot.Head.Sha)
		}
		// null, not an empty object: the status was never read, and "clean" would
		// be a different claim.
		if snapshot.Uncommitted != nil {
			t.Fatal("uncommitted must stay null when the status could not be read")
		}
	})

	t.Run("[TC-PDAGENT-021] never marshals a slice as null", func(t *testing.T) {
		// A nil Go slice becomes `null` on the wire, zod's .default([]) only fills
		// `undefined`, and the whole frame is then rejected — the host silently
		// vanishes from the dashboard. Checked on the emptiest snapshot there is.
		snapshot := CollectRepoSnapshot(ctx, SnapshotOptions{
			Path:   filepath.Join(fix.Root, "not-a-repo"),
			Name:   "ghost",
			Limit:  10,
			Ledger: NewDetailLedger(0, nil),
		})
		encoded, err := json.Marshal(snapshot)
		if err != nil {
			t.Fatal(err)
		}
		for _, forbidden := range []string{`"refs":null`, `"commits":null`, `"details":null`} {
			if strings.Contains(string(encoded), forbidden) {
				t.Fatalf("snapshot carried %s: %s", forbidden, encoded)
			}
		}
	})
}

func TestDetailSnapshot(t *testing.T) {
	fix := newFixture(t)
	ctx := context.Background()

	t.Run("[TC-PDAGENT-038] answers a detail request with details only (partial)", func(t *testing.T) {
		snapshot := CollectDetailSnapshot(ctx, DetailOptions{
			Path:   fix.Repo,
			Name:   "demo",
			Shas:   []string{fix.MergeSha},
			Ledger: NewDetailLedger(0, nil),
		})
		if !snapshot.Partial {
			t.Fatal("a detail reply must be marked partial")
		}
		if len(snapshot.Details) != 1 || snapshot.Details[0].Sha != fix.MergeSha {
			t.Fatalf("details = %+v", snapshot.Details)
		}
		if snapshot.Details[0].Subject != "chore: merge feature (ours)" {
			t.Fatalf("subject = %q", snapshot.Details[0].Subject)
		}
		// The rows the server already has must NOT be rebuilt for one click.
		if len(snapshot.Commits) != 0 || len(snapshot.Refs) != 0 {
			t.Fatalf("a partial reply rebuilt the graph: %d commits, %d refs", len(snapshot.Commits), len(snapshot.Refs))
		}
		if snapshot.Uncommitted != nil || snapshot.WorkingDiff != nil {
			t.Fatal("a partial reply must carry no status and no working diff")
		}
	})

	t.Run("[TC-PDAGENT-038] produces a requested sha even when the budget is spent", func(t *testing.T) {
		ledger := NewDetailLedger(0, nil)
		options := repoOptions(fix, 100)
		options.Ledger = ledger
		CollectRepoSnapshot(ctx, options)

		// Everything is in the ledger now; an explicit request still gets answered.
		snapshot := CollectDetailSnapshot(ctx, DetailOptions{
			Path:   fix.Repo,
			Name:   "demo",
			Shas:   []string{fix.MergeSha},
			Ledger: ledger,
		})
		if len(snapshot.Details) != 1 {
			t.Fatalf("details = %d, want 1", len(snapshot.Details))
		}
	})

	t.Run("[TC-PDAGENT-039] refuses a sha that could be read as a git option", func(t *testing.T) {
		var seen [][]string
		snapshot := CollectDetailSnapshot(ctx, DetailOptions{
			Path: fix.Repo,
			Name: "demo",
			// The middle one is 15 characters long — a perfectly valid length for a
			// short sha, which is exactly why the check is on the CHARACTERS.
			Shas:   []string{"--upload-pack=touch /tmp/pwned", "--output=/tmp/pwned", "zzzzzzz"},
			Ledger: NewDetailLedger(0, nil),
			Runner: func(_ context.Context, args []string, _ CallOptions) (string, error) {
				seen = append(seen, append([]string{}, args...))
				return "", nil
			},
		})
		if len(snapshot.Details) != 0 {
			t.Fatalf("details = %+v, want none", snapshot.Details)
		}
		// Nothing reached git at all — the filter runs before any argv is built.
		if len(seen) != 0 {
			t.Fatalf("git was called with %v", seen)
		}
	})
}

func paths(files []protocol.DiffFile) []string {
	out := []string{}
	for _, file := range files {
		out = append(out, file.Path)
	}
	return out
}

func findDetail(details []protocol.CommitDetail, subject string) *protocol.CommitDetail {
	for index, detail := range details {
		if detail.Subject == subject {
			return &details[index]
		}
	}
	return nil
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for index := range a {
		if a[index] != b[index] {
			return false
		}
	}
	return true
}
