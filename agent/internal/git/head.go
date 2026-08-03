package git

import (
	"context"
	"strconv"
	"strings"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// AheadBehind is a branch's divergence from its upstream. Both fields are
// pointers because "we could not count" and "zero commits apart" are different
// answers, and only one of them means the branch is up to date.
type AheadBehind struct {
	Ahead  *int
	Behind *int
}

// ParseAheadBehind reads `rev-list --left-right --count <upstream>...HEAD`.
//
// The LEFT count is the upstream's exclusive commits (how far HEAD is behind)
// and the RIGHT count is HEAD's (how far it is ahead) — the order is fixed by
// the `<left>...<right>` argument, not by the flag.
func ParseAheadBehind(text string) AheadBehind {
	parts := strings.Fields(text)
	if len(parts) != 2 {
		return AheadBehind{}
	}
	behind, err := strconv.Atoi(parts[0])
	if err != nil {
		return AheadBehind{}
	}
	ahead, err := strconv.Atoi(parts[1])
	if err != nil {
		return AheadBehind{}
	}
	return AheadBehind{Ahead: &ahead, Behind: &behind}
}

// ReadHead describes where the checkout is standing: a branch or a detached
// sha, plus divergence from the branch's upstream.
func ReadHead(ctx context.Context, git Runner) (protocol.GitHead, error) {
	head := protocol.NewGitHead()

	sha, err := absorb(git(ctx, []string{"rev-parse", "HEAD"}, CallOptions{}))
	if err != nil {
		return head, err
	}
	sha = strings.TrimSpace(sha)

	// `--quiet` so a detached HEAD is an empty answer rather than an error on stderr.
	branch, err := absorb(git(ctx, []string{"symbolic-ref", "--quiet", "--short", "HEAD"}, CallOptions{}))
	if err != nil {
		return head, err
	}
	branch = strings.TrimSpace(branch)

	if sha != "" {
		head.Sha = &sha
	}
	if branch != "" {
		head.Branch = &branch
	}
	// An empty repository has neither, and that is not "detached" — it is a
	// checkout with no commits, which the UI draws differently.
	head.Detached = sha != "" && branch == ""
	if branch == "" {
		return head, nil
	}

	upstream, err := absorb(git(ctx,
		[]string{"rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"},
		CallOptions{},
	))
	if err != nil {
		return head, err
	}
	// No upstream is the ordinary state of a local-only branch: this call exits
	// non-zero, absorb() turns that into "", and ahead/behind stay null because
	// there is nothing to be ahead OF.
	if upstream = strings.TrimSpace(upstream); upstream == "" {
		return head, nil
	}
	head.Upstream = &upstream

	counts, err := absorb(git(ctx,
		[]string{"rev-list", "--left-right", "--count", upstream + "...HEAD"},
		CallOptions{},
	))
	if err != nil {
		return head, err
	}
	divergence := ParseAheadBehind(counts)
	head.Ahead = divergence.Ahead
	head.Behind = divergence.Behind
	return head, nil
}
