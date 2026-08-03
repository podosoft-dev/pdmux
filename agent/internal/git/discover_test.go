package git

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRepositoryDiscovery(t *testing.T) {
	fix := newFixture(t)
	ctx := context.Background()

	t.Run("[TC-PDAGENT-028] finds checkouts under a root and one level of submodules", func(t *testing.T) {
		sub := filepath.Join(fix.Repo, "vendor")
		if err := os.MkdirAll(sub, 0o755); err != nil {
			t.Fatal(err)
		}
		setup(t, sub, "init", "-q", "-b", "main")
		write(t, filepath.Join(fix.Repo, ".gitmodules"), strings.Join([]string{
			`[submodule "vendor"]`,
			"\tpath = vendor",
			"\turl = ../vendor.git",
			"",
		}, "\n"))

		found := Discover(ctx, []string{fix.Root}, 0)
		names := []string{}
		for _, repo := range found {
			names = append(names, repo.Name)
			if !strings.HasPrefix(repo.Path, fix.Root) {
				t.Fatalf("%s is outside the configured root", repo.Path)
			}
		}
		// One level each way: the root is a directory of checkouts, and a checkout
		// may carry submodules people work in as if they were repositories.
		if got := sortedStrings(names); !equalStrings(got, []string{"demo", "demo/vendor"}) {
			t.Fatalf("names = %v", got)
		}
	})

	t.Run("[TC-PDAGENT-028] ignores a configured root that does not exist", func(t *testing.T) {
		if found := Discover(ctx, []string{filepath.Join(fix.Root, "nowhere")}, 0); len(found) != 0 {
			t.Fatalf("found = %+v, want none", found)
		}
	})

	t.Run("[TC-PDAGENT-028] treats a root that IS a checkout as the repository", func(t *testing.T) {
		found := Discover(ctx, []string{fix.Repo}, 0)
		if len(found) == 0 || found[0].Name != "demo" {
			t.Fatalf("found = %+v", found)
		}
	})

	t.Run("[TC-PDAGENT-028] never reports the same checkout twice", func(t *testing.T) {
		// Two roots that overlap — a common way to configure "~/work" and one
		// project inside it — must not double the repository on the dashboard.
		found := Discover(ctx, []string{fix.Root, fix.Repo}, 0)
		seen := map[string]bool{}
		for _, repo := range found {
			if seen[repo.Path] {
				t.Fatalf("%s reported twice", repo.Path)
			}
			seen[repo.Path] = true
		}
	})

	t.Run("[TC-PDAGENT-028] stops at the repository cap", func(t *testing.T) {
		if found := Discover(ctx, []string{fix.Root}, 1); len(found) != 1 {
			t.Fatalf("found %d repositories with a cap of 1", len(found))
		}
	})
}

// UNTAGGED: DiscoveryResult.MissingRoots feeds the `git.root_missing`
// diagnostic, whose TCs (TC-PDAGENT-043/044) belong to the diagnostics
// collector. Nothing in the matrix pins the scan's own half of it.
func TestDiscoveryReportsBarrenRoots(t *testing.T) {
	fix := newFixture(t)
	ctx := context.Background()

	t.Run("reports a root that is absent or holds no checkout", func(t *testing.T) {
		empty := t.TempDir()
		missing := filepath.Join(fix.Root, "nowhere")
		result := DiscoverDetailed(ctx, []string{fix.Root, empty, missing}, 0)

		if len(result.Repos) == 0 {
			t.Fatal("the good root produced nothing")
		}
		// Silently skipping these is how a typo in a configured root stays
		// invisible for weeks; the scan already knows, so it says so.
		if got := sortedStrings(result.MissingRoots); !equalStrings(got, sortedStrings([]string{empty, missing})) {
			t.Fatalf("missing roots = %v", got)
		}
	})

	t.Run("never returns a nil slice", func(t *testing.T) {
		result := DiscoverDetailed(ctx, nil, 0)
		if result.Repos == nil || result.MissingRoots == nil {
			t.Fatalf("nil slice in %+v", result)
		}
	})
}
