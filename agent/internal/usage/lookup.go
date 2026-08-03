package usage

// Finding a coding CLI that a service manager's PATH cannot see.
//
// THE PROBLEM, MEASURED: the agent runs under `systemd --user`, whose PATH is
// `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/snap/bin` and
// nothing else. Coding CLIs are almost never there — they are installed per-user by nvm,
// volta, bun, pipx, Homebrew or a plain `~/.local/bin`. On this fleet `codex` sat in
// `~/.nvm/versions/node/v20.19.6/bin` and `exec.Start` returned "not found", which the
// collector reports as "no windows" because from its side that is genuinely
// indistinguishable from a CLI that is not installed.
//
// WHY RESOLVE HERE RATHER THAN ONLY FIX THE UNIT FILE: a unit file is written once, at
// install time. Every host already in the field would keep the broken PATH until someone
// reinstalled the agent by hand. Resolving in-process fixes them all on the next agent
// update, which is a thing that already happens on its own.
//
// This only ever LOOKS for a binary the operator chose to have collected. It does not
// install anything, and a miss is still reported as "no windows".

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/podosoft-dev/pdmux/agent/internal/sys"
)

// ResolveBinary is sys.ResolveBinary — the lookup is not a usage concern, it is
// what "run a tool on this host" means when a service manager owns your PATH.
// Kept as a name here because this package's callers and specs read better for it.
func ResolveBinary(bin string, home string) string {
	return sys.ResolveBinary(bin, home)
}

// EnvForBinary returns the environment to run resolved under.
//
// ⚠ FINDING THE BINARY IS NOT ENOUGH. These CLIs are scripts with a `#!/usr/bin/env node`
// shebang, so they resolve their own runtime from PATH at exec time. Measured here: with
// `codex` reachable but only the distro's node on PATH, it died with
// `SyntaxError: Unexpected reserved word` — node 12 parsing a top-level `await`. The
// operator's shell works because nvm put the matching runtime first; a service manager's
// PATH has never heard of it.
//
// So the directory the binary was found in goes on the FRONT of PATH, which is where its
// sibling runtime lives. Prepending rather than replacing keeps every system tool the CLI
// might shell out to reachable.
func EnvForBinary(resolved string) []string {
	// ⚠ BOTH DIRECTORIES, AND THE ORDER MATTERS. Two real layouts disagree about
	// where the runtime sits, and picking either one alone breaks the other:
	//
	//   nvm       ~/.nvm/versions/node/<v>/bin/{codex,node}   — beside the REAL file.
	//             The operator's "fix" for not-on-PATH is a link into /usr/local/bin,
	//             whose directory holds no node, so following the link is required.
	//   homebrew  /opt/homebrew/bin/codex -> ../lib/node_modules/@openai/codex/bin/
	//             codex.js, and node is beside the LINK. Following the symlink alone
	//             lands in a directory with no runtime at all.
	//
	// Measured: under a launchd service's PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) the
	// homebrew case died with `env: node: No such file or directory`, exit 127 — so
	// every Mac running its agent as a service reported no usage for a CLI that was
	// installed and running. Real file first (nvm's sibling runtime is the specific
	// answer), link second (homebrew's), inherited PATH last.
	dirs := []string{}
	// Deduped by CANONICAL path, kept as written. On macOS the same directory is
	// reached as both /var/... and /private/var/..., and comparing the literals
	// would put one directory in PATH twice.
	seen := map[string]bool{}
	add := func(path string) {
		dir := filepath.Dir(path)
		if dir == "" || dir == "." {
			return
		}
		key := dir
		if real, err := filepath.EvalSymlinks(dir); err == nil {
			key = real
		}
		if seen[key] {
			return
		}
		seen[key] = true
		dirs = append(dirs, dir)
	}
	// Best effort: a broken link keeps the literal path and fails as it did.
	if real, err := filepath.EvalSymlinks(resolved); err == nil {
		add(real)
	}
	add(resolved)
	if len(dirs) == 0 {
		return nil
	}
	prefix := strings.Join(dirs, string(os.PathListSeparator))

	environ := os.Environ()
	for index, entry := range environ {
		if after, found := strings.CutPrefix(entry, "PATH="); found {
			if after == "" {
				environ[index] = "PATH=" + prefix
			} else {
				environ[index] = "PATH=" + prefix + string(os.PathListSeparator) + after
			}
			return environ
		}
	}
	return append(environ, "PATH="+prefix)
}
