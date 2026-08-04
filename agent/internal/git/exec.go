// Package git collects a read-only picture of the checkouts on this host.
//
// Someone is working in these repositories. Everything here is arranged so that
// "read-only" is a property of the code rather than a promise in a README: the
// only way to start a git process is exec.go's runner, and that runner refuses
// any subcommand outside an enumerated whitelist. The cost is bounded too — a
// fleet dashboard may not turn into a git client that pegs a developer's laptop.
//
// Ported from apps/agent/src/git/**. The caps, the ack ledger and the truncation
// flags all exist because of specific measured failures; those explanations are
// carried over with the code, because they are the specification.
package git

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"

	"github.com/podosoft-dev/pdmux/agent/internal/sys"
)

// ReadOnlySubcommands are the subcommands that cannot modify a repository, its
// index or its objects.
//
// `fetch`, `gc`, `checkout`, `reset` and `clean` cannot be reached from here at
// all — and a test asserts the refusal, because a grep for those words also hits
// comments and slice literals and proves nothing.
//
// ⚠ `ls-remote` IS ON THIS LIST AND `fetch` IS STILL NOT, WHICH IS THE WHOLE
// POINT OF THE DISTINCTION. Both talk to the remote; only one writes. `ls-remote`
// asks the remote which refs it has and prints them — it downloads no objects,
// updates no remote-tracking ref, and does not write `FETCH_HEAD`, so the
// repository somebody is working in is byte-for-byte unchanged. That is what
// makes it the only way to answer "what does the remote have RIGHT NOW" without
// giving up the structural guarantee this package exists to keep.
var ReadOnlySubcommands = []string{
	"rev-parse",
	"symbolic-ref",
	"for-each-ref",
	"status",
	"log",
	"rev-list",
	"config",
	"show",
	"diff",
	"ls-remote",
}

// EnvGitBin names an alternative git binary, which is how a test points the
// collector at a stub without touching PATH.
const EnvGitBin = "PDMUX_GIT_BIN"

// DefaultTimeoutMs bounds a call that does not ask for its own budget.
const DefaultTimeoutMs = 20_000

// Field and record separators — control characters no commit message can carry,
// so a subject full of tabs, pipes or newlines still parses.
const (
	FieldSep  = "\x1f"
	RecordSep = "\x1e"
)

// ErrFailed reports that git ran and did not succeed: a non-whitelisted exit
// code, a timeout, or no git at all.
//
// It is deliberately DIFFERENT from a WriteAttemptError. This is the
// TypeScript's `null` return, which every caller absorbs locally ("that
// measurement is unavailable"), while an attempt to run a writing subcommand is
// a programming error that must travel up and be reported on the snapshot.
var ErrFailed = errors.New("git call failed")

// WriteAttemptError is returned when a caller asks for a subcommand that is not
// on the whitelist. Reaching this is a bug in the agent, never a fact about the
// host, so it is an error rather than an empty result.
type WriteAttemptError struct{ Subcommand string }

func (e *WriteAttemptError) Error() string {
	return fmt.Sprintf("refusing non-read-only git subcommand: %s", e.Subcommand)
}

// CallOptions tunes one call. The zero value is the common case.
type CallOptions struct {
	// TimeoutMs bounds this call; zero means DefaultTimeoutMs.
	TimeoutMs int
	// OK lists exit codes that count as success; nil means {0}. `diff --no-index`
	// exits 1 when the files differ, which is the normal result there.
	OK []int
}

// Runner runs one read-only git call in a fixed repository.
//
// It is a function type rather than an interface so a test can substitute a
// closure and assert the exact argv the collector would have handed to git.
type Runner func(ctx context.Context, args []string, options CallOptions) (string, error)

// AssertReadOnly is the whitelist check, exported so a test can drive it
// directly rather than inferring it from a runner's behaviour.
func AssertReadOnly(args []string) error {
	subcommand := ""
	if len(args) > 0 {
		subcommand = args[0]
	}
	if !slices.Contains(ReadOnlySubcommands, subcommand) {
		return &WriteAttemptError{Subcommand: subcommand}
	}
	return nil
}

// Binary is the git executable to run.
func Binary() string {
	if bin := os.Getenv(EnvGitBin); bin != "" {
		return bin
	}
	return "git"
}

// NewRunner returns a runner bound to one checkout.
func NewRunner(repo string) Runner {
	return NewRunnerWithBinary(repo, Binary())
}

// NewRunnerWithBinary is NewRunner with an explicit executable.
func NewRunnerWithBinary(repo, gitBin string) Runner {
	return func(ctx context.Context, args []string, options CallOptions) (string, error) {
		if err := AssertReadOnly(args); err != nil {
			return "", err
		}
		timeout := options.TimeoutMs
		if timeout <= 0 {
			timeout = DefaultTimeoutMs
		}
		// `--no-optional-locks` pairs with GIT_OPTIONAL_LOCKS=0 below: without
		// them a plain `git status` refreshes the index and takes
		// `.git/index.lock`, which collides with the human's own `git commit`.
		// That is a real failure path, not a theoretical one.
		argv := append([]string{"--no-optional-locks", "-C", repo}, args...)
		result := sys.Run(ctx, gitBin, argv, sys.Options{TimeoutMs: timeout, Env: environ()})

		ok := options.OK
		if len(ok) == 0 {
			ok = []int{0}
		}
		if result.NotFound || result.TimedOut || !slices.Contains(ok, result.Code) {
			return "", fmt.Errorf("%w: git %s exited %d", ErrFailed, args[0], result.Code)
		}
		return result.Stdout, nil
	}
}

// environ is the agent's environment plus the three variables every git call in
// this package depends on.
//
// Appending is enough to override: exec.Cmd documents that when Env holds a
// duplicated key, the LAST value is the one used.
func environ() []string {
	return append(os.Environ(),
		// See the lock note in NewRunnerWithBinary.
		"GIT_OPTIONAL_LOCKS=0",
		// A repository with a credential-prompting remote must not park a hidden
		// process waiting for a password nobody will ever type.
		"GIT_TERMINAL_PROMPT=0",
		// ⚠ AND THE SAME GUARANTEE FOR SSH, which the line above does not give.
		// `GIT_TERMINAL_PROMPT` governs git's own credential prompts; an ssh remote
		// with a passphrase-protected key hands the terminal to `ssh`, which asks
		// on its own and would sit there until the call's timeout. Nothing here is
		// interactive, so batch mode is simply the truth about this process — and it
		// only started to matter when `ls-remote` gave this package a subcommand
		// that reaches the network at all.
		"GIT_SSH_COMMAND=ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
		// Every parser in this package matches English porcelain/plumbing output.
		"LC_ALL=C",
	)
}

// absorb turns a failed git call into empty output.
//
// It exists so the call sites read like the TypeScript's nullish-coalescing to
// an empty string, while still letting a WriteAttemptError travel up. Used where
// "git could not
// answer" and "git answered with nothing" lead to the same snapshot; callers
// that must tell the two apart (status, in particular) check ErrFailed directly,
// because collapsing "unknown" into "clean" is the one lie that matters here.
func absorb(out string, err error) (string, error) {
	if errors.Is(err, ErrFailed) {
		return "", nil
	}
	return out, err
}

// ignoreFailure is absorb for a caller that has already substituted its own
// empty result and only needs to know whether the error must still travel.
func ignoreFailure(err error) error {
	if errors.Is(err, ErrFailed) {
		return nil
	}
	return err
}
