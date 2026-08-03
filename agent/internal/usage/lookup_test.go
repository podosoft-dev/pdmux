package usage

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A coding CLI installed per-user is invisible to `systemd --user`'s PATH. Measured on
// this fleet: `codex` sat in `~/.nvm/versions/node/v20.19.6/bin`, the spawn failed, and
// the collector reported "no windows" — indistinguishable, from its side, from a CLI
// that simply is not installed.
func TestResolveBinary(t *testing.T) {
	home := t.TempDir()
	nvmBin := filepath.Join(home, ".nvm", "versions", "node", "v20.19.6", "bin")
	if err := os.MkdirAll(nvmBin, 0o755); err != nil {
		t.Fatal(err)
	}
	// ⚠ A NAME NO MACHINE CAN HAVE, not the real `codex`.
	//
	// `extraBinDirs` searches absolute system directories too (`/opt/homebrew/bin`),
	// and it searches them BEFORE the nvm glob. So on a developer's Mac with codex
	// installed by homebrew, this test resolved the machine's own copy and failed —
	// asserting nothing about the per-user lookup it exists to pin. The scenario is
	// name-independent, so the fixture uses a name that cannot collide.
	const bin = "pdmux-fixture-cli"
	tool := filepath.Join(nvmBin, bin)
	if err := os.WriteFile(tool, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Run("[TC-PDAGENT-104] finds a per-user install a service PATH cannot see", func(t *testing.T) {
		t.Setenv("PATH", "/usr/bin:/bin")
		if got := ResolveBinary(bin, home); got != tool {
			t.Fatalf("resolved %q, want %q", got, tool)
		}
	})

	t.Run("[TC-PDAGENT-104] leaves an absolute path alone", func(t *testing.T) {
		// An explicit path is the operator's decision; never second-guess it.
		if got := ResolveBinary("/opt/custom/codex", home); got != "/opt/custom/codex" {
			t.Fatalf("resolved %q, want it unchanged", got)
		}
	})

	t.Run("[TC-PDAGENT-104] returns the bare name when nothing matches", func(t *testing.T) {
		// The caller's error then stays the ordinary "not installed" it has always been,
		// rather than becoming a confusing path that was never on this host.
		t.Setenv("PATH", "/usr/bin:/bin")
		if got := ResolveBinary("definitely-not-installed", home); got != "definitely-not-installed" {
			t.Fatalf("resolved %q, want the bare name", got)
		}
	})

	t.Run("[TC-PDAGENT-104] does not treat a directory as a binary", func(t *testing.T) {
		if err := os.MkdirAll(filepath.Join(home, ".local", "bin", "trap"), 0o755); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PATH", "/usr/bin:/bin")
		if got := ResolveBinary("trap", home); got != "trap" {
			t.Fatalf("resolved %q, want the bare name", got)
		}
	})
}

// Finding the binary is only half of it: these CLIs are `#!/usr/bin/env node` scripts and
// resolve their own runtime from PATH. Measured here: `codex` reachable but only the
// distro's node on PATH died with `SyntaxError: Unexpected reserved word` — node 12
// parsing a top-level `await`.
func TestEnvForBinary(t *testing.T) {
	home := t.TempDir()
	realDir := filepath.Join(home, ".nvm", "versions", "node", "v20.19.6", "bin")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	real := filepath.Join(realDir, "codex")
	if err := os.WriteFile(real, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	// ⚠ THE EXPECTATION HAS TO BE EVALUATED TOO. `EnvForBinary` resolves symlinks on
	// purpose (the runtime lives beside the REAL file, not beside a link), and on macOS
	// `t.TempDir()` is already behind one: /var is a symlink to /private/var. Comparing
	// against the unresolved path failed on every Mac while the code was doing exactly
	// what it is documented to do.
	wantDir, err := filepath.EvalSymlinks(realDir)
	if err != nil {
		t.Fatal(err)
	}

	pathOf := func(environ []string) string {
		for _, entry := range environ {
			if strings.HasPrefix(entry, "PATH=") {
				return strings.TrimPrefix(entry, "PATH=")
			}
		}
		return ""
	}

	t.Run("[TC-PDAGENT-104] puts the CLI's own directory first so it finds its runtime", func(t *testing.T) {
		t.Setenv("PATH", "/usr/bin:/bin")
		got := pathOf(EnvForBinary(real))
		if want := wantDir + string(os.PathListSeparator) + "/usr/bin:/bin"; got != want {
			t.Fatalf("PATH = %q, want %q", got, want)
		}
	})

	t.Run("[TC-PDAGENT-104] follows a symlink to where the runtime actually lives", func(t *testing.T) {
		// The obvious operator fix for "not on PATH" is a link into /usr/local/bin — and
		// that directory holds no node. Taking the link's own directory would put us back
		// at the distro runtime, which is the failure we are here to avoid.
		linkDir := filepath.Join(home, "usr-local-bin")
		if err := os.MkdirAll(linkDir, 0o755); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(linkDir, "codex")
		if err := os.Symlink(real, link); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PATH", "/usr/bin:/bin")
		got := pathOf(EnvForBinary(link))
		if !strings.HasPrefix(got, wantDir+string(os.PathListSeparator)) {
			t.Fatalf("PATH = %q, want it to start with the real directory %q", got, wantDir)
		}
	})

	t.Run("[TC-PDMCP-012] finds the runtime when it sits beside the LINK, not the target", func(t *testing.T) {
		// ⚠ THE LAYOUT THIS PINS — homebrew's, which is the opposite of nvm's:
		//   /opt/homebrew/bin/codex -> ../lib/node_modules/@openai/codex/bin/codex.js
		// and `node` lives beside the LINK. Following the symlink alone lands in a
		// directory with no runtime, so under a launchd service's PATH the CLI died
		// with `env: node: No such file or directory` (exit 127) and every Mac
		// running its agent as a service reported no usage for an installed CLI.
		linkDir := filepath.Join(home, "brew-bin")
		targetDir := filepath.Join(home, "lib", "node_modules", "@vendor", "cli", "bin")
		for _, dir := range []string{linkDir, targetDir} {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
		}
		target := filepath.Join(targetDir, "cli.js")
		if err := os.WriteFile(target, []byte("#!/usr/bin/env node\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		// The runtime is beside the link only.
		if err := os.WriteFile(filepath.Join(linkDir, "node"), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(linkDir, "cli")
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}

		t.Setenv("PATH", "/usr/bin:/bin")
		got := pathOf(EnvForBinary(link))
		if !strings.Contains(got, linkDir) {
			t.Fatalf("PATH = %q, want the link's directory (where node is) on it", got)
		}
		// And the target's directory is still there for the layout that needs it.
		realTargetDir, err := filepath.EvalSymlinks(targetDir)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(got, realTargetDir) {
			t.Fatalf("PATH = %q, want the target's directory too", got)
		}
	})

	t.Run("[TC-PDAGENT-104] keeps the rest of PATH reachable", func(t *testing.T) {
		// Replacing PATH instead of prepending would cut the CLI off from every system
		// tool it shells out to.
		t.Setenv("PATH", "/usr/bin:/bin")
		got := pathOf(EnvForBinary(real))
		if !strings.HasSuffix(got, "/usr/bin:/bin") {
			t.Fatalf("PATH = %q, want the inherited entries kept", got)
		}
	})
}
