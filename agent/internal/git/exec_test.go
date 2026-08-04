package git

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestReadOnlyEnforcement(t *testing.T) {
	fix := newFixture(t)
	ctx := context.Background()

	t.Run("[TC-PDAGENT-027] refuses every git subcommand that could write", func(t *testing.T) {
		run := NewRunner(fix.Repo)
		for _, verb := range []string{"fetch", "gc", "checkout", "reset", "clean", "commit", "push", "pull"} {
			_, err := run(ctx, []string{verb}, CallOptions{})
			var refusal *WriteAttemptError
			if !errors.As(err, &refusal) {
				t.Fatalf("git %s returned %v, want a WriteAttemptError", verb, err)
			}
			if refusal.Subcommand != verb {
				t.Fatalf("refusal named %q, want %q", refusal.Subcommand, verb)
			}
		}
		// An empty argv is refused too: "" is not on the whitelist, and a caller
		// that built no subcommand at all must not reach exec.
		if err := AssertReadOnly(nil); err == nil {
			t.Fatal("an empty argv must be refused")
		}
	})

	// ⚠ THE TWO NETWORK SUBCOMMANDS ARE NOT INTERCHANGEABLE, and this is where that
	// is written down. `ls-remote` asks the remote which refs it has; `fetch`
	// downloads objects and rewrites remote-tracking refs in a repository somebody
	// else is working in. Reading the remote is allowed, changing the checkout is
	// not — and adding the first must never quietly admit the second.
	t.Run("[TC-PDAGENT-027] admits ls-remote without admitting fetch", func(t *testing.T) {
		if err := AssertReadOnly([]string{"ls-remote"}); err != nil {
			t.Fatalf("ls-remote was refused: %v", err)
		}
		var refusal *WriteAttemptError
		if err := AssertReadOnly([]string{"fetch"}); !errors.As(err, &refusal) {
			t.Fatalf("fetch returned %v, want a WriteAttemptError", err)
		}
	})

	// ⚠ NOTHING HERE IS INTERACTIVE, AND SSH HAS TO BE TOLD SEPARATELY.
	// `GIT_TERMINAL_PROMPT=0` silences git's own credential prompt but not `ssh`,
	// which asks for a key passphrase itself — so an ssh remote would hold the call
	// until its timeout. It only became reachable when `ls-remote` gave this package
	// a subcommand that talks to a network at all.
	t.Run("[TC-PDAGENT-027] never lets a git call wait for a human", func(t *testing.T) {
		env := environ()
		for key, needle := range map[string]string{
			"GIT_TERMINAL_PROMPT": "0",
			"GIT_SSH_COMMAND":     "BatchMode=yes",
		} {
			found := ""
			for _, entry := range env {
				if strings.HasPrefix(entry, key+"=") {
					found = entry
				}
			}
			if found == "" || !strings.Contains(found, needle) {
				t.Fatalf("%s = %q, want it to carry %q", key, found, needle)
			}
		}
	})

	t.Run("[TC-PDAGENT-027] allows the read-only calls the collector needs", func(t *testing.T) {
		run := NewRunner(fix.Repo)
		out, err := run(ctx, []string{"rev-parse", "HEAD"}, CallOptions{})
		if err != nil {
			t.Fatalf("rev-parse HEAD: %v", err)
		}
		if !regexp.MustCompile(`^[0-9a-f]{40}`).MatchString(out) {
			t.Fatalf("rev-parse HEAD returned %q", out)
		}
	})

	t.Run("[TC-PDAGENT-026] leaves .git byte-for-byte unchanged across a full pass", func(t *testing.T) {
		before := fingerprintGitDir(t, fix.Repo)

		// `git status` normally refreshes the index and takes .git/index.lock,
		// which collides with the human's own commit. Polling for the lock is the
		// only way to see it: the file is created and removed within one call.
		var (
			mu       sync.Mutex
			lockSeen bool
			stop     = make(chan struct{})
			watching sync.WaitGroup
		)
		watching.Add(1)
		go func() {
			defer watching.Done()
			lock := filepath.Join(fix.Repo, ".git", "index.lock")
			for {
				select {
				case <-stop:
					return
				default:
				}
				if _, err := os.Stat(lock); err == nil {
					mu.Lock()
					lockSeen = true
					mu.Unlock()
				}
				time.Sleep(time.Millisecond)
			}
		}()

		CollectRepoSnapshot(ctx, SnapshotOptions{
			Path:         fix.Repo,
			Name:         "demo",
			Limit:        100,
			DetailBudget: 100,
			Ledger:       NewDetailLedger(0, nil),
		})

		close(stop)
		watching.Wait()

		mu.Lock()
		seen := lockSeen
		mu.Unlock()
		if seen {
			t.Fatal("the pass took .git/index.lock; GIT_OPTIONAL_LOCKS/--no-optional-locks are not in force")
		}
		if after := fingerprintGitDir(t, fix.Repo); !reflect.DeepEqual(before, after) {
			t.Fatalf("the pass modified .git\nbefore: %v\nafter:  %v", before, after)
		}
	})
}

func TestRunnerFailureIsNotAnError(t *testing.T) {
	requireGit(t)
	ctx := context.Background()

	t.Run("[TC-PDAGENT-021] a failing git call is a missing measurement, not a broken pass", func(t *testing.T) {
		run := NewRunner(filepath.Join(t.TempDir(), "not-a-repo"))
		_, err := run(ctx, []string{"rev-parse", "HEAD"}, CallOptions{})
		if !errors.Is(err, ErrFailed) {
			t.Fatalf("a failed call returned %v, want ErrFailed", err)
		}
		// absorb() is what turns that into the TypeScript's empty string, so every
		// collector can keep going without inspecting an error type.
		out, err := absorb(run(ctx, []string{"rev-parse", "HEAD"}, CallOptions{}))
		if out != "" || err != nil {
			t.Fatalf("absorb() = (%q, %v), want (\"\", nil)", out, err)
		}
		// A refusal must NOT be absorbed: it is a bug in the agent, and swallowing
		// it here is how a write attempt would become invisible.
		_, err = absorb(run(ctx, []string{"fetch"}, CallOptions{}))
		var refusal *WriteAttemptError
		if !errors.As(err, &refusal) {
			t.Fatalf("absorb() swallowed a refusal: %v", err)
		}
	})

	t.Run("[TC-PDAGENT-027] a missing git binary is a fact about the host, not a crash", func(t *testing.T) {
		run := NewRunnerWithBinary(t.TempDir(), filepath.Join(t.TempDir(), "no-such-git"))
		if _, err := run(ctx, []string{"status"}, CallOptions{}); !errors.Is(err, ErrFailed) {
			t.Fatalf("a missing binary returned %v, want ErrFailed", err)
		}
	})
}
