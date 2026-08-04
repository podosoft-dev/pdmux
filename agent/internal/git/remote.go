package git

import (
	"context"
	"strings"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// RemoteTimeoutMs bounds a call that leaves the machine.
//
// Every other call in this package reads local files and finishes in
// milliseconds; this one waits on a network and, on a repository whose remote is
// unreachable, waits for as long as it is allowed to. Ten seconds is long enough
// for a slow forge and short enough that a person who pressed a button gets an
// answer rather than a spinner — and the pass this runs in must not be held
// hostage by one repository's dead remote.
const RemoteTimeoutMs = 10_000

// DefaultRemoteRefCap bounds what one check reports. A remote with more refs
// than this is a UI problem rather than a data problem, and the frame still has
// to be accepted.
const DefaultRemoteRefCap = 2_000

// ReadRemote asks the remote which refs it has RIGHT NOW.
//
// ⚠ THIS IS THE ONE CALL HERE THAT TALKS TO A NETWORK, AND IT STILL WRITES
// NOTHING. `ls-remote` prints the remote's refs; it downloads no objects, moves
// no remote-tracking ref and does not touch `FETCH_HEAD`. That is the whole
// reason it can be on the read-only whitelist while `fetch` cannot: the
// repository somebody is working in is byte-for-byte unchanged afterwards, which
// is the guarantee this package exists to keep.
//
// ⚠ AND IT ANSWERS A NARROWER QUESTION THAN IT LOOKS. Knowing the remote's sha
// says whether the local ref differs, not by how much — counting commits needs
// the objects, and those only arrive with a fetch. Callers must not turn "the
// shas differ" into a number.
//
// The remote is left unnamed on purpose: git resolves the current branch's
// upstream and falls back to `origin`, which is the same choice the person at
// that machine would get from a bare `git ls-remote`. A checkout with no remote
// at all fails the call, and that is reported as "no remote" rather than as an
// error nobody can act on.
func ReadRemote(ctx context.Context, run Runner, cap int) ([]protocol.GitRemoteRef, error) {
	if cap <= 0 {
		cap = DefaultRemoteRefCap
	}
	out, err := run(ctx, []string{"ls-remote", "--heads", "--tags"}, CallOptions{TimeoutMs: RemoteTimeoutMs})
	if err != nil {
		return nil, err
	}
	return parseRemoteRefs(out, cap), nil
}

// parseRemoteRefs turns `ls-remote` output into contract rows.
//
// Each line is `<sha>\t<refname>`. A tag that points at another object also
// yields a `^{}` line naming the object it resolves to; both are dropped,
// because the graph identifies a tag by the tag object the remote advertises and
// a second row under the same name would read as two tags.
func parseRemoteRefs(out string, cap int) []protocol.GitRemoteRef {
	refs := make([]protocol.GitRemoteRef, 0, 16)
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		sha, name, ok := strings.Cut(line, "\t")
		if !ok || sha == "" || name == "" {
			continue
		}
		if strings.HasSuffix(name, "^{}") {
			continue
		}
		kind, short, ok := classifyRemoteRef(name)
		if !ok {
			continue
		}
		if len(refs) >= cap {
			break
		}
		refs = append(refs, protocol.GitRemoteRef{Name: short, SHA: sha, Kind: kind})
	}
	return refs
}

// classifyRemoteRef strips the namespace and says which one it was.
func classifyRemoteRef(name string) (protocol.RemoteKind, string, bool) {
	switch {
	case strings.HasPrefix(name, "refs/heads/"):
		return protocol.RemoteBranch, strings.TrimPrefix(name, "refs/heads/"), true
	case strings.HasPrefix(name, "refs/tags/"):
		return protocol.RemoteTag, strings.TrimPrefix(name, "refs/tags/"), true
	}
	// HEAD and anything else the remote advertises is not a branch or a tag, and
	// the graph has nowhere to draw it.
	return "", "", false
}

// RemoteOptions configure one remote check.
type RemoteOptions struct {
	Path string
	Name string
	// Run is injected so a spec can drive this without a network.
	Run Runner
	Cap int
	Now func() int64
}

// CollectRemoteSnapshot answers a remote check with a PARTIAL snapshot.
//
// The same shape `CollectDetailSnapshot` uses: refs and commit rows have not
// changed because of this call, the server already holds them, and rebuilding
// them would cost a full graph pass to deliver one list of shas.
//
// ⚠ AN UNREACHABLE REMOTE IS AN ANSWER, NOT A FAILURE. No remote configured, no
// network, an expired credential — each of those is a fact about the checkout
// that the person looking at the screen needs, and none of them is a reason to
// send nothing. The error travels in the frame.
func CollectRemoteSnapshot(ctx context.Context, options RemoteOptions) protocol.RepoSnapshot {
	at := nowOr(options.Now)
	run := options.Run
	if run == nil {
		run = NewRunner(options.Path)
	}
	snapshot := protocol.NewRepoSnapshot()
	snapshot.Path = options.Path
	snapshot.Name = options.Name
	snapshot.Ts = at
	snapshot.Partial = true

	check := protocol.NewGitRemoteCheck()
	check.CheckedAt = at
	refs, err := ReadRemote(ctx, run, options.Cap)
	if err != nil {
		message := err.Error()
		check.Error = &message
	} else {
		check.Refs = refs
	}
	snapshot.Remote = &check
	return snapshot
}
