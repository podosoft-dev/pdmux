#!/usr/bin/env bash
# Run what CI runs, before pushing.
#
# ⚠ THIS EXISTS BECAUSE VERIFYING PER-PACKAGE IS NOT VERIFYING. Three pushes in a row
# failed on `@pdmux/protocol`'s suite — the contract's key-set freeze and its
# generated-schema list, both of which exist to be updated deliberately when the
# contract grows. Every other workspace had been run by hand; that one had not, and
# nothing said so until GitHub did, minutes later, on main.
#
# It mirrors `.github/workflows/ci.yml`'s `verify` and `agent-version` jobs, in their
# order, and stops at the first failure with the name CI gives that step. What it does
# NOT cover is stated at the bottom rather than left to be discovered.
#
# Usage:
#   tools/preflight.sh            # everything below
#   tools/preflight.sh --quick    # skip the Go suite and the agent binaries
set -uo pipefail

cd "$(dirname "$0")/.."

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

failures=()
step() {
	local name="$1"
	shift
	printf '\n\033[1m→ %s\033[0m\n' "$name"
	if "$@"; then
		printf '\033[32m  ok\033[0m — %s\n' "$name"
	else
		printf '\033[31m  FAILED\033[0m — %s\n' "$name"
		failures+=("$name")
	fi
}

# The packages build first because the apps consume their compiled output — the same
# order and the same reason as the workflow.
build_packages() {
	for pkg in @pdmux/protocol @pdmux/core @pdmux/ui @pdmux/mcp; do
		bun run --filter "$pkg" build >/dev/null || return 1
	done
}

build_apps() {
	bun run --filter pdmux-api build >/dev/null || return 1
	bun run --filter pdmux-web build >/dev/null || return 1
}

web_smoke() { bun run test:web-build; }

# ⚠ `--workspaces`, NOT A LIST. Naming the workspaces is how one gets left out, which
# is the failure this file exists for.
lint() { bun run --workspaces --if-present lint; }
unit() { bun run --workspaces --if-present test; }
release_workflow() { bun run test:release-workflow; }
audit() { bun run audit:generic; }

# ⚠ A GENERATED FILE THAT IS COMMITTED CAN GO STALE, AND ITS STALENESS IS SILENT.
# Every generator below is deterministic for exactly this reason: the committed bytes
# are compared, not regenerated.
#
# ⚠ `docs/AGENT_GO.md` SAID CI CAUGHT THE CONTRACT ONES AND, FOR A LONG TIME, IT DID
# NOT — no workflow called `schema:check` or `expect:check`, and the conformance corpus
# had been stale since `fsPut`/`fsDelete`/`fsGet` were added, which is precisely the
# failure that document describes: "the corpus quietly stops covering whatever you just
# added". It surfaced only because an unrelated change ran `expect:build` and the diff
# came back larger than the change. The workflow's `verify` job runs them now too; this
# is the copy that answers before the push rather than minutes after it.
#
# ⚠ THE ORDER MATTERS AND IT IS NOT ARBITRARY. `expect:check` reads the package's
# `dist/`, not `src/`, so it is only meaningful after `build packages` above.
#
# The Go half of the same pipeline is already covered: `schema_hash.go` pins the JSON
# artifacts and a Go test compares it, so `agent go suite` fails if somebody edits the
# zod and skips `go generate`.
generated() {
	bun run --cwd packages/protocol schema:check || return 1
	bun run --cwd packages/protocol expect:check || return 1
	# The file-type icons are vendored SVGs turned into a string module; edit the
	# directory without re-running the generator and the app keeps serving the previous
	# set, which looks like nothing at all.
	bun tools/build-file-icons.mjs --check
}

# The agent is a Go module rather than a Bun workspace, so the workflow checks it in
# a separate job. Same commands.
go_suite() {
	command -v go >/dev/null || { echo "  (no Go toolchain here — CI still checks this)"; return 0; }
	(cd agent && go build ./... && go vet ./... && go test ./...)
}

# ⚠ THE BUMP IS THE RELEASE. A change to the agent or the contract published under the
# version already out there is invisible: hosts compare version strings, see equality
# and never fetch the new build. CI compares against the push's base; here the nearest
# honest equivalent is the upstream branch.
agent_version() {
	local base
	base=$(git rev-parse --verify --quiet '@{upstream}' 2>/dev/null) || {
		echo "  (no upstream to compare against — CI still checks this)"
		return 0
	}
	local changed
	# The Zod-free terminal parser is browser-only and parity-tested against the schema embedded by the agent.
	changed=$(git diff --name-only "$base" HEAD -- agent packages/protocol |
		grep -Ev '(_test\.go$|/testdata/|^packages/protocol/test/|^packages/protocol/conformance/|^packages/protocol/src/terminal\.ts$|/package\.json$|^bun\.lock$)' || true)
	[ -z "$changed" ] && { echo "  no agent or contract source changed"; return 0; }

	echo "  changed:"; echo "$changed" | sed 's/^/    /'
	local read_version before after
	# ⚠ `sed -nE`, NOT THE BRE THE WORKFLOW USES. CI runs GNU sed; this runs wherever
	# somebody develops, and BSD sed (macOS) matches nothing for `\{1,\}` here — so
	# both reads came back EMPTY and compared equal, which reports "not bumped" no
	# matter what the versions are. A gate that is right by accident is not a gate.
	read_version() {
		git show "$1:agent/internal/cli/version.go" 2>/dev/null |
			sed -nE 's/^[[:space:]]*(var|const)[[:space:]]+AgentVersion[[:space:]]*=[[:space:]]*"([^"]*)".*/\2/p'
	}
	before=$(read_version "$base")
	after=$(read_version HEAD)
	if [ -z "$after" ]; then
		echo "  could not read AgentVersion at HEAD"
		return 1
	fi
	if [ "$before" = "$after" ]; then
		echo "  AgentVersion is still ${after} — a release nobody downloads"
		return 1
	fi
	echo "  AgentVersion ${before:-<absent>} -> ${after}"
}

step "build packages" build_packages
step "build apps" build_apps
step "web production smoke" web_smoke
step "lint" lint
step "unit tests" unit
step "release workflow" release_workflow
step "generated artifacts" generated
step "generalization audit" audit
step "agent version bump" agent_version
[ "$QUICK" = 1 ] || step "agent go suite" go_suite

printf '\n'
if [ ${#failures[@]} -eq 0 ]; then
	printf '\033[32m✓ preflight passed\033[0m — CI runs these same steps.\n'
	# ⚠ SAY WHAT WAS NOT CHECKED. A green run that quietly skipped something is worse
	# than no run: it is a reason to stop looking.
	cat <<-'NOTE'

	  Not covered here, and still able to fail:
	    · the agent BINARIES job (`bun run build:agent`, checksum and version match)
	      — minutes of cross-compilation, so run it when `agent/**` changed
	    · traceability (`./check.sh` in the workspace) — the matrices live there, and
	      CI cannot see them
	    · e2e — it needs a running stack
	NOTE
	exit 0
fi

printf '\033[31m✗ preflight failed\033[0m — %s\n' "${failures[*]}"
printf '  Push and these fail again on GitHub, on main, minutes later.\n'
exit 1
