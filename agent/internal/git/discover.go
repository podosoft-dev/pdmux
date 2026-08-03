package git

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// DefaultMaxRepos bounds one discovery pass.
const DefaultMaxRepos = 64

// DiscoveredRepo is one checkout the scan found.
type DiscoveredRepo struct {
	Path string
	// Name is the display name — the checkout's directory, or `<repo>/<submodule path>`.
	Name string
}

// DiscoveryResult is what one scan of the configured roots produced.
type DiscoveryResult struct {
	Repos []DiscoveredRepo
	// MissingRoots are configured roots that yielded nothing — the directory is
	// absent, or it is neither a checkout nor a directory of checkouts. The scan
	// already learns this, so reporting `git.root_missing` needs no extra work;
	// silently skipping it is how a typo in a root stays invisible for weeks.
	MissingRoots []string
}

// IsCheckout reports whether dir is a git checkout.
//
// `.git` is a DIRECTORY in a normal clone and a FILE in a worktree or a
// submodule, so the test is existence rather than type — otherwise every
// submodule, which is exactly what this scan goes looking for, is invisible.
func IsCheckout(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, ".git"))
	return err == nil
}

// SubmodulePaths reads the submodule paths declared in `.gitmodules`.
//
// This is a config read: no network, no `submodule init`, nothing written. Exit
// status 1 means there is no `.gitmodules`, which is the common case and not a
// failure.
func SubmodulePaths(ctx context.Context, repo string) []string {
	git := NewRunner(repo)
	text, err := absorb(git(ctx,
		[]string{"config", "-f", ".gitmodules", "--get-regexp", `^submodule\..*\.path$`},
		CallOptions{OK: []int{0, 1}},
	))
	if err != nil {
		// The only error left here is a whitelist violation, which cannot happen
		// for a literal `config` call; treat it like "no submodules" rather than
		// failing a scan over it.
		return nil
	}
	paths := []string{}
	for _, line := range strings.Split(text, "\n") {
		// `--get-regexp` prints `<key> <value>`, and a submodule path may contain
		// spaces, so everything after the FIRST space is the value.
		_, value, found := strings.Cut(line, " ")
		if !found {
			continue
		}
		if value = strings.TrimSpace(value); value != "" {
			paths = append(paths, value)
		}
	}
	sort.Strings(paths)
	return paths
}

// childDirectories lists the visible subdirectories of root, sorted.
//
// Dot-directories are skipped: `.git` itself is not a checkout to descend into,
// and neither is anything else a tool hid on purpose.
func childDirectories(root string) []string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	out := []string{}
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		out = append(out, filepath.Join(root, entry.Name()))
	}
	sort.Strings(out)
	return out
}

// DiscoverDetailed finds the checkouts under the configured roots.
//
// WHY ONE LEVEL EACH WAY: a root is either a checkout itself or a directory of
// checkouts ("~/work"), and a checkout may carry submodules that people work in
// as if they were repositories of their own. Recursing further turns a
// `node_modules` full of vendored git metadata into a several-minute pass, so
// the depth is fixed and small rather than configurable.
//
// maxRepos <= 0 means DefaultMaxRepos.
func DiscoverDetailed(ctx context.Context, roots []string, maxRepos int) DiscoveryResult {
	if maxRepos <= 0 {
		maxRepos = DefaultMaxRepos
	}
	result := DiscoveryResult{Repos: []DiscoveredRepo{}, MissingRoots: []string{}}
	seen := map[string]bool{}

	add := func(path, name string) {
		absolute, err := filepath.Abs(path)
		if err != nil {
			return
		}
		if seen[absolute] || len(result.Repos) >= maxRepos {
			return
		}
		seen[absolute] = true
		result.Repos = append(result.Repos, DiscoveredRepo{Path: absolute, Name: name})
	}

	for _, rawRoot := range roots {
		root, err := filepath.Abs(rawRoot)
		if err != nil {
			result.MissingRoots = append(result.MissingRoots, rawRoot)
			continue
		}
		info, err := os.Stat(root)
		if err != nil || !info.IsDir() {
			// A configured root that does not exist does not fail the pass — it is
			// reported as a diagnostic instead.
			result.MissingRoots = append(result.MissingRoots, rawRoot)
			continue
		}
		var tops []string
		if IsCheckout(root) {
			tops = []string{root}
		} else {
			for _, child := range childDirectories(root) {
				if IsCheckout(child) {
					tops = append(tops, child)
				}
			}
		}
		if len(tops) == 0 {
			result.MissingRoots = append(result.MissingRoots, rawRoot)
		}
		for _, top := range tops {
			topName := filepath.Base(top)
			add(top, topName)
			for _, sub := range SubmodulePaths(ctx, top) {
				path := filepath.Join(top, sub)
				if IsCheckout(path) {
					add(path, topName+"/"+sub)
				}
			}
		}
	}
	return result
}

// Discover is DiscoverDetailed without the diagnostic half.
func Discover(ctx context.Context, roots []string, maxRepos int) []DiscoveredRepo {
	return DiscoverDetailed(ctx, roots, maxRepos).Repos
}
