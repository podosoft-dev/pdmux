package update

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/semver"
)

// The refusals in this file are a BLAST-RADIUS AND OPERATOR-ERROR BOUNDARY, NOT
// A TRUST BOUNDARY — and the difference has to be written down or someone will
// eventually delete them as redundant.
//
// A server that can open a PTY on this host can already run anything on it, so
// none of these checks defend against a hostile pdmux; there is nothing here to
// defend. What they defend against is the ordinary way fleets break: a stale row
// in a dashboard, a replayed command, a build published under the wrong
// architecture, a "roll everything back" that would install a version which
// cannot connect, a server bug that re-sends the same command every 10 seconds.
// Each one is cheap, each one turns a class of outage into one reported frame,
// and none of them would be worth arguing about if the failure they prevent were
// recoverable from the dashboard. It is not — that is the whole point.

// precheck runs every refusal that costs nothing, in cost order. The first one
// to fire is the one reported: they are independent reasons, and a host that is
// both the wrong architecture and out of attempts does not need both.
func (e *Engine) precheck(update protocol.AgentUpdate, currentVersion string) error {
	// The frame's own shape is validated against the contract on the way in
	// (internal/protocol compiles the zod schema into the binary), so reaching
	// this point already means artifactPath matched the pattern. It is checked
	// AGAIN here, and that duplication is deliberate:
	//
	//   - the contract's job is to reject a malformed frame at the boundary, for
	//     both languages, from one source of truth;
	//   - this package's job is to be correct on its own terms, because it is the
	//     thing that turns a string into an HTTP request. A future refactor that
	//     hands an AgentUpdate in from somewhere else — a CLI flag, a test, a
	//     replayed frame — must not silently lose the check that keeps this host
	//     from fetching bytes from an origin the server chose.
	//
	// Two layers, two different failure modes covered. Neither is redundant.
	if err := checkArtifactPath(update.ArtifactPath); err != nil {
		return err
	}

	// ARCH first among the host checks: it is the one that would otherwise brick
	// with ENOEXEC, and it is a string comparison.
	if update.OS != "" && update.OS != e.opt.GOOS {
		return refuse(CodeArchMismatch, "this host runs %s, the build is for %s", e.opt.GOOS, update.OS)
	}
	if update.Arch != "" && update.Arch != e.opt.GOARCH {
		return refuse(CodeArchMismatch, "this host is %s, the build is for %s", e.opt.GOARCH, update.Arch)
	}

	if err := checkNotNewer(update, currentVersion); err != nil {
		return err
	}

	// Nothing would start us again, so exiting would end the host's participation
	// in the fleet. Refuse rather than attempt.
	if ability := e.opt.Ability(); !ability.CanRestart {
		return refuse(CodeNoRestartSource, "no service manager would start this agent again after it exits")
	}

	// Checked at ACCEPT time and not at the last rename: a host installed into a
	// directory the service account cannot write is a permanent condition, and
	// finding out about it after a 30MB download and a verify run is a worse way
	// to learn it. It also means the operator sees one refusal instead of a
	// failure that looks transient.
	if err := e.checkExeWritable(); err != nil {
		return err
	}

	return checkRate(e.dir, update.Version, e.opt.Now(), e.opt.MaxAttempts, e.opt.RateWindow)
}

// checkNotNewer refuses a version that is not ahead of what is running.
//
// This is the refusal that catches a stale dashboard row, a replayed command,
// and the genuinely dangerous one: "roll the whole fleet back to a version that
// cannot connect". `force` is how an operator says they mean it — a deliberate
// downgrade is a real need (the new build is bad), and it stays fully gated by
// verify-then-commit, so `force` skips the comparison and nothing else.
func checkNotNewer(update protocol.AgentUpdate, currentVersion string) error {
	if update.Force {
		return nil
	}
	order, ok := semver.CompareStrings(update.Version, currentVersion)
	if !ok {
		// One of the two is not SemVer. A development build (`0.1.0-dev+g1a2b3c`
		// parses; something hand-edited may not) must remain updatable, so an
		// UNCOMPARABLE pair is allowed through rather than refused: the comparison
		// exists to catch a stale row, and a version we cannot read is not evidence
		// of one. Gate 1 still has to pass.
		return nil
	}
	if order > 0 {
		return nil
	}
	return refuse(CodeNotNewer, "%s is not newer than the running %s (use force for a deliberate downgrade)",
		update.Version, currentVersion)
}

// checkArtifactPath enforces "the URL is derived, never supplied".
//
// ⚠ THE POINT IS NOT TIDINESS. `artifactPath` is joined onto the origin in the
// agent's OWN config — the one it authenticated to. If an absolute URL were
// accepted here, one frame would become "every host in the fleet fetches
// arbitrary bytes from an arbitrary origin, using the fleet's egress identity
// and its network position". That is a new capability (SSRF), not a
// convenience, and it is exactly the kind that is invisible until it is used.
func checkArtifactPath(path string) error {
	switch {
	case path == "":
		return refuse(CodeBadArtifactPath, "the update carries no artifact path")
	case strings.Contains(path, "://"):
		return refuse(CodeBadArtifactPath, "artifact path is a URL, not a path: %q", path)
	case !strings.HasPrefix(path, "/"):
		return refuse(CodeBadArtifactPath, "artifact path must start with /: %q", path)
	case strings.HasPrefix(path, "//"):
		// Protocol-relative: `//evil.example/x` resolves against ANOTHER HOST.
		return refuse(CodeBadArtifactPath, "artifact path may not start with //: %q", path)
	case strings.Contains(path, ".."):
		// Structurally harmless — the request cannot leave our own origin either
		// way — but a path that walks is never one we published, so it is a bug
		// worth naming rather than following.
		return refuse(CodeBadArtifactPath, "artifact path may not contain ..: %q", path)
	case !artifactPathPattern.MatchString(path):
		return refuse(CodeBadArtifactPath, "artifact path has characters we do not publish: %q", path)
	}
	return nil
}

// checkExeWritable answers "can this process replace its own binary".
//
// THE THING BEING CHECKED IS THE DIRECTORY, not the file, and the code name is
// the contract's rather than the mechanism's. The swap creates `<exe>.bak` and
// renames `<exe>.new` over `<exe>`; both are directory operations. The
// executable's own mode is irrelevant — writing into a running binary returns
// ETXTBSY no matter what it says.
//
// It is a write PROBE rather than a mode-bit reading (which is what
// cli.DirWritableBy does) because the question here is about THIS process, right
// now, and only the kernel knows the answer once uid 0, ACLs and read-only
// mounts are in play. cli asks a different question — "could a DIFFERENT account
// write here" — where a probe would answer for the wrong user.
func (e *Engine) checkExeWritable() error {
	if e.opt.ExePath == "" {
		return refuse(CodeExeNotWritable, "cannot resolve the path of the running binary")
	}
	dir := filepath.Dir(e.opt.ExePath)
	probe, err := os.CreateTemp(dir, ".pdmux-update-")
	if err != nil {
		return refuse(CodeExeNotWritable, "cannot write into %s: %v", dir, err)
	}
	name := probe.Name()
	probe.Close()
	os.Remove(name)
	if _, err := os.Stat(e.opt.ExePath); err != nil {
		return refuse(CodeExeNotWritable, "cannot stat the running binary %s: %v", e.opt.ExePath, err)
	}
	return nil
}
