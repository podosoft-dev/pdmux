package git

import (
	"context"
	"regexp"
	"strconv"
	"strings"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// DefaultRefCap bounds how many refs one snapshot carries. The contract's own
// limit is 2000; a repository with more of them has a UI problem, not a data
// problem, and the frame must still be accepted.
const DefaultRefCap = 2_000

// refPatterns are the three ref namespaces, read separately so each entry knows
// which one it came from without re-parsing its name.
//
// ⚠ A `remote` entry is a LOCAL remote-tracking ref: it is exactly as fresh as
// the last fetch a human ran. This collector never fetches (that writes to the
// repo and hits the network), so the UI has to label those refs accordingly.
var refPatterns = []struct {
	Pattern string
	Kind    protocol.GitRefKind
}{
	{"refs/heads/", protocol.GitRefLocal},
	{"refs/remotes/", protocol.GitRefRemote},
	{"refs/tags/", protocol.GitRefTag},
}

// RefFormat is the `for-each-ref` format: name, object, upstream, tracking.
var RefFormat = strings.Join([]string{
	"%(refname)",
	"%(objectname)",
	"%(upstream:short)",
	"%(upstream:track)",
}, FieldSep)

var (
	aheadRe  = regexp.MustCompile(`ahead (\d+)`)
	behindRe = regexp.MustCompile(`behind (\d+)`)
)

// Track is a parsed `%(upstream:track)` field.
type Track struct {
	Ahead  int
	Behind int
	// Gone marks an upstream branch that has been deleted on the remote — a
	// branch whose "behind 0" is meaningless and which can only be pushed anew.
	Gone bool
}

// ParseTrack reads `[ahead 2, behind 1]`, or `[gone]`.
func ParseTrack(track string) Track {
	parsed := Track{Gone: strings.Contains(track, "gone")}
	if match := aheadRe.FindStringSubmatch(track); match != nil {
		parsed.Ahead, _ = strconv.Atoi(match[1])
	}
	if match := behindRe.FindStringSubmatch(track); match != nil {
		parsed.Behind, _ = strconv.Atoi(match[1])
	}
	return parsed
}

// ParseRefBlock turns one `for-each-ref` block into refs of a single kind.
func ParseRefBlock(text, pattern string, kind protocol.GitRefKind) []protocol.GitRef {
	out := []protocol.GitRef{}
	for _, line := range strings.Split(text, "\n") {
		if line == "" {
			continue
		}
		parts := strings.Split(line, FieldSep)
		refname := field(parts, 0)
		sha := field(parts, 1)
		if refname == "" || sha == "" {
			continue
		}
		// TrimPrefix rather than a blind slice by length: identical for every line
		// for-each-ref prints, and it cannot panic on a truncated one.
		name := strings.TrimPrefix(refname, pattern)
		// `origin/HEAD` is a symbolic pointer, not a branch anybody can check out.
		if kind == protocol.GitRefRemote && strings.HasSuffix(name, "/HEAD") {
			continue
		}
		ref := protocol.NewGitRef()
		ref.Name = name
		ref.Kind = kind
		ref.Sha = sha
		// Only a local branch can track something; a remote-tracking ref or a tag
		// has no upstream, and leaving those counts null says so.
		if kind == protocol.GitRefLocal {
			if upstream := field(parts, 2); upstream != "" {
				track := ParseTrack(field(parts, 3))
				ref.Upstream = &upstream
				ref.Ahead = ptr(track.Ahead)
				ref.Behind = ptr(track.Behind)
				ref.Gone = track.Gone
			}
		}
		out = append(out, ref)
	}
	return out
}

// ReadRefs lists local branches, remote-tracking branches and tags.
// refCap <= 0 means DefaultRefCap.
func ReadRefs(ctx context.Context, git Runner, refCap int) ([]protocol.GitRef, error) {
	if refCap <= 0 {
		refCap = DefaultRefCap
	}
	out := []protocol.GitRef{}
	for _, namespace := range refPatterns {
		text, err := absorb(git(ctx,
			[]string{"for-each-ref", "--format=" + RefFormat, namespace.Pattern},
			CallOptions{},
		))
		if err != nil {
			return out, err
		}
		out = append(out, ParseRefBlock(text, namespace.Pattern, namespace.Kind)...)
		// Checked between namespaces rather than per ref: a repository with 50,000
		// tags should not also pay for reading the tags after the cap is spent.
		if len(out) >= refCap {
			break
		}
	}
	if len(out) > refCap {
		out = out[:refCap]
	}
	return out, nil
}
