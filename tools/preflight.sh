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
		npm run build -w "$pkg" >/dev/null || return 1
	done
}

build_apps() {
	npm run build -w pdmux-api >/dev/null || return 1
	npm run build -w pdmux-web >/dev/null || return 1
}

# ⚠ `--workspaces`, NOT A LIST. Naming the workspaces is how one gets left out, which
# is the failure this file exists for.
lint() { npm run lint --workspaces --if-present; }
unit() { npm test --workspaces --if-present; }
audit() { npm run audit:generic; }

# The agent is a Go module rather than an npm workspace, so the workflow checks it in
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
	changed=$(git diff --name-only "$base" HEAD -- agent packages/protocol |
		grep -Ev '(_test\.go$|/testdata/|^packages/protocol/test/|^packages/protocol/conformance/|/package(-lock)?\.json$)' || true)
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
step "lint" lint
step "unit tests" unit
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
	    · the agent BINARIES job (`npm run build:agent`, checksum and version match)
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
