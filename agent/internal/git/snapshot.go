package git

import (
	"context"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// errorMaxChars is the contract's cap on the snapshot error string.
const errorMaxChars = 512

// Ledger is the part of the commit-detail ledger a snapshot needs. It is an
// interface so a test can watch what a pass decided to skip without owning a
// state directory.
type Ledger interface {
	Has(repo, sha string) bool
	Record(repo, sha string)
}

// SnapshotOptions describes one pass over one checkout.
type SnapshotOptions struct {
	Path string
	Name string
	// Limit is the graph window: how many commit ROWS to read.
	Limit int
	// DetailBudget is the maximum number of NEW commit details this pass may build.
	DetailBudget int
	Ledger       Ledger
	// StatusFileCap and BodyMaxChars come from the server; zero means this
	// package's default.
	StatusFileCap int
	BodyMaxChars  int
	// Runner is injected in tests; nil builds a real read-only runner for Path.
	Runner Runner
	// Now is injected in tests; nil uses the wall clock.
	Now func() int64
}

func (o SnapshotOptions) runner() Runner {
	if o.Runner != nil {
		return o.Runner
	}
	return NewRunner(o.Path)
}

func (o SnapshotOptions) now() int64 { return nowOr(o.Now) }

// nowOr is the injection point for the clock; the contract's timestamps are
// whole epoch seconds, so nothing here ever carries sub-second precision.
func nowOr(clock func() int64) int64 {
	if clock != nil {
		return clock()
	}
	return time.Now().Unix()
}

func (o SnapshotOptions) ledger() Ledger {
	if o.Ledger != nil {
		return o.Ledger
	}
	// A missing ledger costs re-computation on the next pass, never a panic in
	// the middle of one.
	return NewDetailLedger(0, nil)
}

func emptySnapshot(path, name string, ts int64, limit int) protocol.RepoSnapshot {
	snapshot := protocol.NewRepoSnapshot()
	snapshot.Path = path
	snapshot.Name = name
	snapshot.Ts = ts
	snapshot.Limit = limit
	return snapshot
}

func buildDetail(ctx context.Context, git Runner, sha string, body CommitBody) (protocol.CommitDetail, error) {
	patch, err := ReadCommitPatch(ctx, git, sha)
	if err != nil {
		return protocol.CommitDetail{}, err
	}
	detail := protocol.NewCommitDetail()
	detail.Sha = sha
	detail.Subject = body.Subject
	detail.Body = body.Body
	detail.BodyTruncated = body.BodyTruncated
	detail.Files = patch.Files
	detail.Dropped = patch.Dropped
	detail.Truncated = patch.Truncated
	detail.Empty = patch.Empty
	detail.AuthorEmail = body.AuthorEmail
	detail.Committer = body.Committer
	detail.CommitterEmail = body.CommitterEmail
	detail.CommitterDate = body.CommitterDate
	return detail, nil
}

// CollectRepoSnapshot builds one repository's whole read-only picture.
//
// Cost is bounded on purpose (this is a fleet dashboard, not a git client): the
// newest `Limit` commits as ROWS, at most `StatusFileCap` status entries, and at
// most `DetailBudget` NEW commit details. Details are produced NEWEST-FIRST
// because the commits somebody is about to click are the recent ones; the rest
// fill in over the next few passes and `pending` says how many are still missing
// so the UI can be honest about it.
//
// It never returns an error: one broken checkout must not blank the whole host,
// so a failure lands in the snapshot's own `error` field and the rest of the
// fleet still reports.
func CollectRepoSnapshot(ctx context.Context, options SnapshotOptions) protocol.RepoSnapshot {
	base := emptySnapshot(options.Path, options.Name, options.now(), options.Limit)
	snapshot, err := collectRepo(ctx, options, base)
	if err != nil {
		base.Error = ptr(clip(err.Error(), errorMaxChars))
		return base
	}
	return snapshot
}

func collectRepo(ctx context.Context, options SnapshotOptions, snapshot protocol.RepoSnapshot) (protocol.RepoSnapshot, error) {
	git := options.runner()
	ledger := options.ledger()

	log, err := ReadCommits(ctx, git, options.Limit, options.BodyMaxChars)
	if err != nil {
		return snapshot, err
	}
	status, err := ReadStatus(ctx, git, options.StatusFileCap)
	if err != nil {
		return snapshot, err
	}
	head, err := ReadHead(ctx, git)
	if err != nil {
		return snapshot, err
	}
	refs, err := ReadRefs(ctx, git, 0)
	if err != nil {
		return snapshot, err
	}
	snapshot.Head = head
	snapshot.Refs = refs
	snapshot.Commits = log.Commits
	snapshot.Uncommitted = status
	snapshot.Truncated = log.Truncated

	// A clean tree gets no working diff at all: three more git calls that can
	// only produce empty patches, on every repository, on every pass.
	if status != nil && status.Total > 0 {
		diff, err := ReadWorkingDiff(ctx, git, status)
		if err != nil {
			return snapshot, err
		}
		snapshot.WorkingDiff = &diff
	}

	missing := []string{}
	for _, commit := range log.Commits {
		if !ledger.Has(options.Path, commit.Sha) {
			missing = append(missing, commit.Sha)
		}
	}
	budget := max(options.DetailBudget, 0)
	spent := min(budget, len(missing))

	for _, sha := range missing[:spent] {
		detail, err := buildDetail(ctx, git, sha, log.Bodies[sha])
		if err != nil {
			return snapshot, err
		}
		snapshot.Details = append(snapshot.Details, detail)
		// Recorded even when EMPTY: a merge shown against its first parent often
		// has no patch, and without the marker it is recomputed on every pass
		// forever and eats the whole budget.
		ledger.Record(options.Path, sha)
	}
	snapshot.Pending = len(missing) - spent
	return snapshot, nil
}

// DetailOptions describes one answer to a `commitDetail` request.
type DetailOptions struct {
	Path         string
	Name         string
	Shas         []string
	Ledger       Ledger
	BodyMaxChars int
	Runner       Runner
	Now          func() int64
}

// CollectDetailSnapshot answers one `commitDetail` request: `partial: true`,
// details only.
//
// WHY PARTIAL EXISTS: replying to a single click used to mean rebuilding the
// whole graph — every ref and every commit row — so the server could receive the
// one patch it asked for. Those rows have not changed since the last pass and
// the server already has them.
func CollectDetailSnapshot(ctx context.Context, options DetailOptions) protocol.RepoSnapshot {
	// `limit` describes a graph window this frame does not carry; it stays at the
	// schema's minimum rather than repeating a number that means nothing here.
	base := emptySnapshot(options.Path, options.Name, nowOr(options.Now), 1)
	base.Partial = true

	details, err := collectDetails(ctx, options)
	if err != nil {
		base.Error = ptr(clip(err.Error(), errorMaxChars))
		return base
	}
	base.Details = details
	return base
}

func collectDetails(ctx context.Context, options DetailOptions) ([]protocol.CommitDetail, error) {
	details := []protocol.CommitDetail{}
	// Anything that is not a plain sha is dropped HERE, before an argv exists —
	// see IsSha. This is the only place a server-supplied string reaches git.
	shas := []string{}
	for _, sha := range options.Shas {
		if IsSha(sha) {
			shas = append(shas, sha)
		}
	}
	if len(shas) == 0 {
		return details, nil
	}

	git := options.Runner
	if git == nil {
		git = NewRunner(options.Path)
	}
	ledger := options.Ledger
	if ledger == nil {
		ledger = NewDetailLedger(0, nil)
	}

	bodies, err := ReadCommitBodies(ctx, git, shas, options.BodyMaxChars)
	if err != nil {
		return details, err
	}
	for _, sha := range shas {
		// The budget does not apply: somebody clicked this commit, and the ledger
		// records it so the next pass does not build it a second time.
		detail, err := buildDetail(ctx, git, sha, bodies[sha])
		if err != nil {
			return details, err
		}
		details = append(details, detail)
		ledger.Record(options.Path, sha)
	}
	return details, nil
}
