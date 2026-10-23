package git

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestQuotedPatchPaths(t *testing.T) {
	data, err := os.ReadFile("testdata/diff-paths.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct{ Name, Header, Path, OldPath string }
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run("[TC-PDGIT-016] "+tc.Name, func(t *testing.T) {
			files := SplitPatch(tc.Header + "\n@@ -1 +1 @@\n-old\n+new\n")
			if len(files) != 1 {
				t.Fatalf("files = %+v", files)
			}
			f := files[0]
			if f.Path != tc.Path {
				t.Fatalf("path = %q, want %q", f.Path, tc.Path)
			}
			if tc.OldPath != tc.Path && (f.OldPath == nil || *f.OldPath != tc.OldPath) {
				t.Fatalf("old path = %v, want %q", f.OldPath, tc.OldPath)
			}
			if f.Add != 1 || f.Del != 1 {
				t.Fatalf("counts = %d/%d", f.Add, f.Del)
			}
		})
	}
	t.Run("[TC-PDGIT-016] extended headers disambiguate rename separators", func(t *testing.T) {
		text := "diff --git a/old b/name.md b/new b/name.md\nsimilarity index 100%\nrename from old b/name.md\nrename to new b/name.md\n"
		files := SplitPatch(text)
		if len(files) != 1 || files[0].Path != "new b/name.md" || files[0].OldPath == nil || *files[0].OldPath != "old b/name.md" || files[0].Status != "R" {
			t.Fatalf("rename = %+v", files)
		}
	})
	t.Run("[TC-PDGIT-016] hunk content starting with header markers is retained", func(t *testing.T) {
		f := SplitPatch("diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n--- heading\n+++ heading\n")[0]
		if f.Add != 1 || f.Del != 1 || len(f.Lines) != 3 {
			t.Fatalf("patch = %+v", f)
		}
	})
}

// Only the disposable repository is exposed to Git, even from a Git hook.
func quotedGit(t *testing.T, root string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = root
	for _, item := range os.Environ() {
		key := strings.SplitN(item, "=", 2)[0]
		if !strings.HasPrefix(key, "GIT_") {
			cmd.Env = append(cmd.Env, item)
		}
	}
	cmd.Env = append(cmd.Env, "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_SYSTEM="+os.DevNull, "GIT_OPTIONAL_LOCKS=0", "GIT_AUTHOR_NAME=Example", "GIT_AUTHOR_EMAIL=example@example.invalid", "GIT_COMMITTER_NAME=Example", "GIT_COMMITTER_EMAIL=example@example.invalid")
	data, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, data)
	}
	return string(data)
}

func TestRealGitQuotedPatch(t *testing.T) {
	requireGit(t)
	root := t.TempDir()
	quotedGit(t, root, "init", "-q")
	if err := os.MkdirAll(filepath.Join(root, "docs"), 0700); err != nil {
		t.Fatal(err)
	}
	path := "docs/베이스라인 문서.md"
	write(t, filepath.Join(root, path), "old\n")
	quotedGit(t, root, "add", ".")
	quotedGit(t, root, "commit", "-q", "-m", "initial")
	write(t, filepath.Join(root, path), "new\n")
	quotedGit(t, root, "add", ".")
	quotedGit(t, root, "commit", "-q", "-m", "change")
	sha := strings.TrimSpace(quotedGit(t, root, "rev-parse", "HEAD"))
	write(t, filepath.Join(root, path), "working tree\n")
	run := func(_ context.Context, args []string, _ CallOptions) (string, error) {
		return quotedGit(t, root, args...), nil
	}
	for _, value := range []string{"true", "false"} {
		t.Run("[TC-PDGIT-016] quotePath="+value, func(t *testing.T) {
			quotedGit(t, root, "config", "core.quotePath", value)
			before := fingerprintGitDir(t, root)
			patch, err := ReadCommitPatch(context.Background(), run, sha)
			if err != nil || len(patch.Files) != 1 || patch.Files[0].Path != path {
				t.Fatalf("patch = %+v, error=%v", patch, err)
			}
			diff, err := ReadWorkingDiff(context.Background(), run, nil)
			if err != nil || len(diff.Unstaged) != 1 || diff.Unstaged[0].Path != path {
				t.Fatalf("working diff = %+v, error=%v", diff, err)
			}
			if !reflect.DeepEqual(before, fingerprintGitDir(t, root)) {
				t.Fatal("collector modified .git")
			}
		})
	}
}
