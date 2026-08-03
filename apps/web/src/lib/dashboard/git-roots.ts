import type { AgentDiagnostic } from "@pdmux/protocol";
import type { HostGitRootView, RepoRow } from "./types";

const GIT_MISSING = "git.missing";
const GIT_ROOT_MISSING = "git.root_missing";

/**
 * What the git-roots card says about one row.
 *
 * `missing` is the whole point of this module: a path is TYPED HERE and used on
 * another machine, so a typo is the only failure mode this feature really has,
 * and until now nothing on the screen said a word about it — the agent has
 * reported `git.root_missing` since it was written and the web app read only
 * `mux.missing` and `listeners.unavailable`.
 */
export type GitRootStatus = "off" | "missing" | "found" | "pending" | "empty";

export interface GitRootRow {
  root: HostGitRootView;
  status: GitRootStatus;
  /** Repositories collected under this root — the proof the path was right. */
  repoCount: number;
}

/**
 * When the agent last finished a git pass on this host, or null if it never has.
 *
 * The agent does not report "I scanned" — it reports what it found. So the only
 * evidence a pass happened is a repository's snapshot time, and a host with no
 * repositories at all leaves no evidence whatsoever. That absence is exactly the
 * case this module has to survive, which is why the caller falls back to a clock.
 */
export function lastGitPassAt(repos: RepoRow[]): number | null {
  let latest: number | null = null;
  for (const repo of repos) {
    if (!repo.lastSnapshotAt) continue;
    const at = Date.parse(repo.lastSnapshotAt);
    if (!Number.isNaN(at) && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

/**
 * Has anything looked at this root yet?
 *
 * ⚠ THE TWO-MINUTE LIE THIS EXISTS FOR. Saving a path pushes a new config to the
 * agent immediately, but the agent's git scan is a timer (`gitIntervalSec`, 120s
 * by default) and a changed root list does NOT re-arm it — `applyConfig` re-arms
 * only when the INTERVAL changed. So a freshly added root waits out the rest of
 * the current cycle, and for up to one interval the card said `gitRoots.empty`:
 * "I looked and there is nothing", when the truth was "nobody has looked".
 * Measured in production: path saved 15:29:27, repositories collected 15:31:15.
 *
 * A pass that finished AFTER the row was created is proof enough — it covered
 * this root, so an empty result is a real answer. With no pass to point at (a
 * host with no repositories anywhere) there is nothing to reason from, so the
 * clock stands in: within one interval of creation, nobody can say yet.
 */
function scanned(root: HostGitRootView, lastPassAt: number | null, now: number, intervalSec: number): boolean {
  const createdAt = Date.parse(root.createdAt);
  if (Number.isNaN(createdAt)) return true;
  if (lastPassAt !== null) return lastPassAt >= createdAt;
  // One interval plus a heartbeat's slack: the row is written here, the config
  // travels, the agent scans, and the result comes back on the next report. A
  // window that is too tight puts `gitRoots.empty` back on screen a moment early,
  // which is the whole defect.
  return now - createdAt > (intervalSec + 30) * 1000;
}

/**
 * The paths an agent said it could not find.
 *
 * ⚠ EXACT MATCH ON A SPLIT LIST, NOT `includes`. The agent joins the missing
 * paths into one message (`joinNames`), and a substring test would report the
 * root `/srv` as missing whenever `/srv/work` was — the wrong row, on a screen
 * whose only job is telling somebody which row they mistyped.
 *
 * ⚠ AND IT DEGRADES TOWARDS SILENCE. The message is capped, so a long list ends
 * `(+3 more)` and those three names are simply not in it. An unnamed root then
 * shows its ordinary state rather than a warning — saying nothing about a root
 * that may be fine is recoverable; painting a working root red is not.
 */
export function missingGitRoots(diagnostics: AgentDiagnostic[]): Set<string> {
  const message = diagnostics.find((entry) => entry.code === GIT_ROOT_MISSING)?.message ?? "";
  const listed = message.slice(message.indexOf(": ") + 1);
  const names = listed
    .replace(/\s*\(\+\d+ more\)\s*$/, "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return new Set(names);
}

/** True when the host has no git at all — every root on it is moot. */
export function gitMissing(diagnostics: AgentDiagnostic[]): boolean {
  return diagnostics.some((entry) => entry.code === GIT_MISSING);
}

/**
 * How many collected repositories sit under a root.
 *
 * ⚠ THE ROOT ITSELF COUNTS. `discover.go` walks one level each way, so the root
 * is either a checkout (one repo, at exactly this path) or a directory of them
 * (`<root>/<name>`). Matching only the second shape reports a zero count for the single
 * -checkout case, which is the arrangement most people start with.
 */
export function reposUnder(root: string, repos: RepoRow[]): number {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return repos.filter((repo) => repo.path === root || repo.path.startsWith(prefix)).length;
}

export function gitRootRows(
  roots: HostGitRootView[],
  repos: RepoRow[],
  diagnostics: AgentDiagnostic[],
  /** `Date.now()` from the caller, so every branch here stays testable. */
  now: number,
  /** The fleet's `gitIntervalSec` — how long "nobody has looked yet" can last. */
  scanIntervalSec: number,
): GitRootRow[] {
  const missing = missingGitRoots(diagnostics);
  const lastPassAt = lastGitPassAt(repos);
  return roots.map((root) => {
    const repoCount = reposUnder(root.path, repos);
    // ⚠ "off" WINS, same as a disabled service. The agent is not looking at a
    // disabled root, so `gitRoots.missing` would be a claim about a path nobody checked.
    if (!root.enabled) return { root, status: "off", repoCount };
    if (missing.has(root.path)) return { root, status: "missing", repoCount };
    if (repoCount > 0) return { root, status: "found", repoCount };
    // ⚠ ORDER: "found" OUTRANKS "pending". A root that already produced
    // repositories has plainly been looked at, whatever the clock says — and a
    // second root added beside it must not turn the first one back into a guess.
    if (!scanned(root, lastPassAt, now, scanIntervalSec)) {
      return { root, status: "pending", repoCount };
    }
    return { root, status: "empty", repoCount };
  });
}

/**
 * Which sentence the git dock shows when it has no repositories to draw.
 *
 * ⚠ ONE SENTENCE COVERED THREE SITUATIONS and only one of them was true.
 * `git.noRepos` reads as "wait a moment" — so a host with no
 * configured path, and a host with no git installed, both looked like a host
 * that was still working on it, for ever.
 */
export type DockEmptyReason = "no-roots" | "no-git" | "none-found";

export function dockEmptyReason(
  /**
   * `HostView.gitRootCount` — the EFFECTIVE count the server computed, so a host
   * with no rows of its own but a fleet list still counts as configured. The dock
   * cannot work that out itself: it never sees the fleet settings.
   */
  gitRootCount: number,
  diagnostics: AgentDiagnostic[],
): DockEmptyReason {
  // ⚠ ORDER MATTERS. A host with no git AND no paths has one cause worth acting
  // on, and it is not the paths — pointing somebody at the settings screen to fix
  // a missing binary sends them somewhere that cannot help.
  if (gitMissing(diagnostics)) return "no-git";
  if (gitRootCount === 0) return "no-roots";
  return "none-found";
}
