import type { FleetSettings } from "../fleet/fleet-settings";
import type { HostGitRoot } from "./host-git-root.entity";

/**
 * ⚠ THE CAP EXISTS BECAUSE OVERFLOWING IT TAKES THE HOST OFF THE DASHBOARD.
 * `agentConfigSchema.gitRoots` is `.max(32)` and `buildAgentConfig` PARSES rather
 * than casts, so a 33rd root makes `build()` throw. The push path swallows that,
 * but the gateway does not — it answers `ws.close(1011, "config unavailable")`,
 * i.e. the agent can no longer connect at all. Refusing the 33rd row turns a host
 * that silently disappears into a form error.
 */
export const MAX_GIT_ROOTS_PER_HOST = 32;

/**
 * The git roots this host should scan.
 *
 * ⚠ THE HOST WINS WHOLE, IT DOES NOT ADD TO THE FLEET LIST. These are absolute
 * paths on one machine; a union would hand every host the other machines' paths
 * too and each one would report `git.root_missing` for the ones it does not have,
 * so "why is this warning here" would have two answers instead of none. A host
 * with no rows keeps using the fleet list, which is what every host does today —
 * so shipping this changes nothing until somebody adds a row.
 *
 * ⚠ AND IT IS CAPPED BEFORE IT IS PARSED, for the reason above the constant.
 *
 * It lives in its own module, free of the HTTP framework and of the agent layer, because two
 * callers need it and they sit on opposite sides of a dependency edge: the config
 * builder, and the host view that tells the git dock whether this host is
 * configured to collect anything at all.
 */
export function resolveGitRoots(settings: FleetSettings, roots: HostGitRoot[]): string[] {
  const own = roots.filter((root) => root.enabled).map((root) => root.path);
  // Rows exist but all are off: that is a deliberate "scan nothing here", not a
  // request to fall back to the fleet's paths.
  const chosen = roots.length > 0 ? own : settings.gitRoots;
  return [...new Set(chosen.map((path) => path.trim()).filter(Boolean))].slice(
    0,
    MAX_GIT_ROOTS_PER_HOST,
  );
}
