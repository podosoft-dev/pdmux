package sys

// Finding a binary a service manager's PATH cannot see.
//
// THE PROBLEM, MEASURED TWICE: the agent runs under `systemd --user` or launchd,
// whose PATH is a handful of system directories and nothing else. Anything a
// person installed for themselves — a version manager, a package manager's
// prefix — is invisible to it, and the failure is always the same shape:
// `exec: "<tool>": executable file not found in $PATH`.
//
//	coding CLIs   `codex` sat in `~/.nvm/versions/node/<v>/bin`, so usage came
//	              back empty and read as "not installed".
//	tmux          installed via a package manager into `/opt/homebrew/bin`, so
//	              every `session` terminal was refused while `shell` ones worked.
//
// So this is not a usage-collection concern; it is what "run a tool on this host"
// means here, which is why it lives beside Run.

import (
	"os"
	"os/exec"
	"path/filepath"
	"sort"
)

// extraBinDirs are the per-user install locations a login shell would have on
// PATH and a service manager does not. Ordered: explicit user bin first, then
// version managers, then system-wide package managers.
func extraBinDirs(home string) []string {
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	if home == "" {
		return nil
	}
	dirs := []string{
		filepath.Join(home, ".local", "bin"),
		filepath.Join(home, "bin"),
		filepath.Join(home, ".volta", "bin"),
		filepath.Join(home, ".bun", "bin"),
		filepath.Join(home, ".asdf", "shims"),
		filepath.Join(home, ".cargo", "bin"),
		filepath.Join(home, "go", "bin"),
		// Both package-manager prefixes: the first is the Apple-silicon default,
		// the second is the Intel one — and neither is on a launchd PATH.
		"/opt/homebrew/bin",
		"/usr/local/bin",
	}
	// nvm keeps one directory per installed runtime and no stable "current"
	// symlink, so the versions are globbed and searched newest-name-last — a host
	// with several node versions should get the one it most likely uses, not the
	// first one alphabetically.
	if matches, err := filepath.Glob(filepath.Join(home, ".nvm", "versions", "node", "*", "bin")); err == nil {
		sort.Sort(sort.Reverse(sort.StringSlice(matches)))
		dirs = append(dirs, matches...)
	}
	return dirs
}

func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	return info.Mode().Perm()&0o111 != 0
}

// ResolveBinary returns the path to run for bin.
//
// PATH first, so an operator who put something on it wins. Then the per-user
// locations above. A name that resolves nowhere is returned unchanged, so the
// caller's error stays the ordinary "not installed" it has always been rather
// than becoming a path that was never on this host.
//
// `home` may be empty, in which case the current user's is used.
func ResolveBinary(bin string, home string) string {
	if bin == "" {
		return bin
	}
	// An explicit path is the operator's decision; never second-guess it.
	if filepath.IsAbs(bin) || filepath.Dir(bin) != "." {
		return bin
	}
	if found, err := exec.LookPath(bin); err == nil {
		return found
	}
	for _, dir := range extraBinDirs(home) {
		candidate := filepath.Join(dir, bin)
		if isExecutableFile(candidate) {
			return candidate
		}
	}
	return bin
}
