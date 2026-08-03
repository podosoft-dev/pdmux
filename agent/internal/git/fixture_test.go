package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// The parsing is the thing under test, so these tests drive a REAL git rather
// than a mock: a stub that emits what we believe porcelain v2 looks like proves
// only that we are self-consistent. A host without git skips instead of failing,
// because "no git installed" is a fact this agent reports rather than a defect.
func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed; the parsing tests need a real repository")
	}
}

// setup runs a git command that WRITES. Test setup may do that; the collector
// under test never may, which is what TC-PDAGENT-026 and TC-PDAGENT-027 assert.
func setup(t *testing.T, repo string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = repo
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=pdmux spec",
		"GIT_AUTHOR_EMAIL=spec@pdmux.test",
		"GIT_COMMITTER_NAME=pdmux spec",
		"GIT_COMMITTER_EMAIL=spec@pdmux.test",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return string(out)
}

type fixture struct {
	Root     string
	Repo     string
	MergeSha string
}

// newFixture builds a checkout with everything the collector has to describe:
// several commits, a second branch, an annotated tag, a merge whose first-parent
// diff is EMPTY (`-s ours`), staged and unstaged changes and an untracked file.
//
// t.TempDir removes the checkout even when the test fails, which the TypeScript
// fixture deliberately did not — it left the repo under the OS temp dir so a
// failed run stayed inspectable. To get that back while debugging, swap the
// t.TempDir call for an os.MkdirTemp with no cleanup; do not make it the default,
// because a suite that leaks a git checkout per run fills a shared workstation.
func newFixture(t *testing.T) fixture {
	t.Helper()
	requireGit(t)
	// Both the setup commands and the collector inherit these: a developer's own
	// ~/.gitconfig (status.showUntrackedFiles, init.defaultBranch, a commit
	// template) would otherwise change what the parsers are handed.
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)

	root := t.TempDir()
	repo := filepath.Join(root, "demo")
	if err := os.Mkdir(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	setup(t, repo, "init", "-q", "-b", "main")
	setup(t, repo, "config", "user.name", "pdmux spec")
	setup(t, repo, "config", "user.email", "spec@pdmux.test")

	write(t, filepath.Join(repo, "a.txt"), "first\n")
	setup(t, repo, "add", "a.txt")
	setup(t, repo, "commit", "-q", "-m", "feat: add a", "-m", "A body line explaining why.")

	write(t, filepath.Join(repo, "b.txt"), "second\n")
	setup(t, repo, "add", "b.txt")
	setup(t, repo, "commit", "-q", "-m", "feat: add b")

	setup(t, repo, "checkout", "-q", "-b", "feature")
	write(t, filepath.Join(repo, "c.txt"), "third\n")
	setup(t, repo, "add", "c.txt")
	setup(t, repo, "commit", "-q", "-m", "feat: add c on feature")

	setup(t, repo, "checkout", "-q", "main")
	write(t, filepath.Join(repo, "d.txt"), "fourth\n")
	setup(t, repo, "add", "d.txt")
	setup(t, repo, "commit", "-q", "-m", "feat: add d on main")

	// `-s ours` keeps main's tree, so the merge has NO patch against its first
	// parent — the case that must be recorded rather than recomputed forever.
	setup(t, repo, "merge", "-q", "-s", "ours", "--no-ff", "-m", "chore: merge feature (ours)", "feature")
	mergeSha := strings.TrimSpace(setup(t, repo, "rev-parse", "HEAD"))
	setup(t, repo, "tag", "-a", "v0.1.0", "-m", "release 0.1.0")

	// Dirty working tree: staged, unstaged and untracked.
	write(t, filepath.Join(repo, "a.txt"), "first\nmodified in the tree\n")
	write(t, filepath.Join(repo, "staged.txt"), "staged content\n")
	setup(t, repo, "add", "staged.txt")
	write(t, filepath.Join(repo, "untracked.txt"), "untracked content\n")

	return fixture{Root: root, Repo: repo, MergeSha: mergeSha}
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// fingerprintGitDir maps every file under `.git` to its size and mtime, which is
// what the read-only invariant is checked against.
func fingerprintGitDir(t *testing.T, repo string) map[string]string {
	t.Helper()
	out := map[string]string{}
	root := filepath.Join(repo, ".git")
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		out[path] = info.ModTime().UTC().Format("2006-01-02T15:04:05.000000000") + ":" +
			strconv.FormatInt(info.Size(), 10)
		return nil
	})
	if err != nil {
		t.Fatalf("walking .git: %v", err)
	}
	return out
}

func sortedStrings(values []string) []string {
	out := append([]string{}, values...)
	sort.Strings(out)
	return out
}
