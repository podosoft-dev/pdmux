package git

import (
	"context"
	"regexp"
	"strconv"
	"strings"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// BodyMaxChars caps one commit message body. The server can lower it; it exists
// so a single runaway message cannot dominate a detail payload either.
const BodyMaxChars = 1_200

// Field caps the contract declares for a commit row, applied here so an
// oversized value is trimmed rather than rejected at the far end.
const (
	authorMaxChars  = 255
	subjectMaxChars = 1024
)

// LogFormat is what a graph draws — sha, parents, decoration, author, date,
// subject — plus the body, which is split off below.
//
// The BODY was 58% of a 250KB repo feed and is only ever read after a click, so
// it never travels with the rows: it is kept aside and attached to a detail.
// ⚠ THE IDENTITY FIELDS ARE APPENDED, NEVER INSERTED. Every index below is
// positional, and the torn-record guard counts fields — moving one would silently
// re-read a subject as a date on the first commit whose message contains the
// separator.
var LogFormat = strings.Join([]string{
	"%H", "%P", "%D", "%an", "%at", "%s", "%b",
	// Detail-only, so they ride with the body rather than with the row: the graph
	// draws neither, and the row feed was already trimmed once for exactly this.
	"%ae", "%cn", "%ce", "%ct",
}, FieldSep)

// CommitBody is a message, kept aside during a log walk so the detail for that
// sha does not have to walk the history again.
type CommitBody struct {
	Subject       string
	Body          string
	BodyTruncated bool
	// AuthorEmail and the committer trio answer "who wrote this and who applied
	// it". They live here rather than on the row because a graph draws neither.
	AuthorEmail    string
	Committer      string
	CommitterEmail string
	CommitterDate  *int64
}

// ParsedLog is one `git log` walk.
type ParsedLog struct {
	Commits []protocol.GitCommit
	// Bodies are message bodies keyed by sha — attached to a detail when one is produced.
	Bodies map[string]CommitBody
	// Truncated is true when `--max-count` cut the history short.
	Truncated bool
}

func emptyLog() ParsedLog {
	return ParsedLog{Commits: []protocol.GitCommit{}, Bodies: map[string]CommitBody{}}
}

var digitsRe = regexp.MustCompile(`^\d+$`)

// ParseLog turns the record-separated log output into rows plus bodies.
func ParseLog(text string, limit, bodyMax int) ParsedLog {
	if bodyMax <= 0 {
		bodyMax = BodyMaxChars
	}
	parsed := emptyLog()
	for _, chunk := range strings.Split(text, RecordSep) {
		if strings.TrimSpace(chunk) == "" {
			continue
		}
		parts := strings.Split(chunk, FieldSep)
		// Six fields is everything a row needs; a shorter chunk is a torn record
		// (a killed git, a full pipe) and half a commit is worse than no commit.
		if len(parts) < 6 {
			continue
		}
		sha := strings.TrimSpace(field(parts, 0))
		if sha == "" {
			continue
		}
		parents := strings.TrimSpace(field(parts, 1))
		decoration := strings.TrimSpace(field(parts, 2))
		author := field(parts, 3)
		when := strings.TrimSpace(field(parts, 4))
		subject := field(parts, 5)
		// %b arrives with the blank line that separates it from the subject.
		body := strings.Trim(field(parts, 6), "\n")

		commit := protocol.NewGitCommit()
		commit.Sha = sha
		if parents != "" {
			commit.Parents = strings.Fields(parents)
		}
		if decoration != "" {
			for _, entry := range strings.Split(decoration, ",") {
				if entry = strings.TrimSpace(entry); entry != "" {
					commit.Refs = append(commit.Refs, entry)
				}
			}
		}
		commit.Author = clip(author, authorMaxChars)
		if digitsRe.MatchString(when) {
			if seconds, err := strconv.ParseInt(when, 10, 64); err == nil {
				commit.Date = &seconds
			}
		}
		commit.Subject = clip(subject, subjectMaxChars)
		parsed.Commits = append(parsed.Commits, commit)

		entry := CommitBody{
			Subject:        commit.Subject,
			Body:           clip(body, bodyMax),
			BodyTruncated:  tooLong(body, bodyMax),
			AuthorEmail:    clip(strings.TrimSpace(field(parts, 7)), authorMaxChars),
			Committer:      clip(strings.TrimSpace(field(parts, 8)), authorMaxChars),
			CommitterEmail: clip(strings.TrimSpace(field(parts, 9)), authorMaxChars),
		}
		// An older agent's format has no tenth field, and a torn record has none
		// either; both leave the date null rather than inventing one.
		if committed := strings.TrimSpace(field(parts, 10)); digitsRe.MatchString(committed) {
			if seconds, err := strconv.ParseInt(committed, 10, 64); err == nil {
				entry.CommitterDate = &seconds
			}
		}
		parsed.Bodies[sha] = entry
	}
	parsed.Truncated = len(parsed.Commits) >= limit
	return parsed
}

// ReadCommits reads the newest `limit` commits across ALL refs, in --date-order.
func ReadCommits(ctx context.Context, git Runner, limit, bodyMax int) (ParsedLog, error) {
	text, err := git(ctx, []string{
		"log",
		"--all",
		"--date-order",
		"--max-count=" + strconv.Itoa(limit),
		"--format=" + RecordSep + LogFormat,
		// A large history is the expensive call in the whole pass, so it gets
		// twice the ordinary budget — and still a bound.
	}, CallOptions{TimeoutMs: 40_000})
	if err != nil {
		// An empty repository, a corrupt object store, a checkout on a stalled
		// mount: no rows, and the rest of the snapshot still goes out.
		return emptyLog(), ignoreFailure(err)
	}
	return ParseLog(text, limit, bodyMax), nil
}

// ShaRe accepts a sha and nothing that could be read as an option.
//
// The contract bounds a sha's LENGTH but not its characters, and these strings
// become argv for git — `--upload-pack=…` is 15 characters long, which is a
// perfectly valid length for a short sha. Anything that is not plain hex is
// dropped rather than passed on.
var ShaRe = regexp.MustCompile(`^[0-9a-fA-F]{7,40}$`)

// IsSha reports whether value may be handed to git as an argument.
func IsSha(value string) bool {
	return ShaRe.MatchString(value)
}

// ReadCommitBodies reads subjects and bodies for specific commits — the
// partial-reply path, which must not pay for a full `--all` walk just to label a
// handful of patches.
func ReadCommitBodies(ctx context.Context, git Runner, shas []string, bodyMax int) (map[string]CommitBody, error) {
	wanted := []string{}
	for _, sha := range shas {
		// See ShaRe: this is the boundary where a request becomes argv.
		if IsSha(sha) {
			wanted = append(wanted, sha)
		}
	}
	if len(wanted) == 0 {
		return map[string]CommitBody{}, nil
	}
	args := append([]string{"log", "--no-walk", "--format=" + RecordSep + LogFormat}, wanted...)
	text, err := git(ctx, args, CallOptions{TimeoutMs: 20_000})
	if err != nil {
		return map[string]CommitBody{}, ignoreFailure(err)
	}
	return ParseLog(text, len(wanted), bodyMax).Bodies, nil
}
