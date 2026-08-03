import { describe, expect, it } from "vitest";
import type { AgentDiagnostic } from "@pdmux/protocol";
import {
  dockEmptyReason,
  gitRootRows,
  missingGitRoots,
  reposUnder,
} from "../src/lib/dashboard/git-roots";
import type { HostGitRootView, RepoRow } from "../src/lib/dashboard/types";

const warn = (code: string, message: string): AgentDiagnostic => ({
  level: "warn",
  code,
  message,
});

const HOUR_AGO = new Date(Date.parse("2026-08-02T14:00:00Z")).toISOString();
const NOW = Date.parse("2026-08-02T15:00:00Z");
const INTERVAL = 120;

const root = (path: string, enabled = true, createdAt = HOUR_AGO): HostGitRootView => ({
  id: path,
  hostId: "h1",
  path,
  enabled,
  sortOrder: 0,
  createdAt,
});

const repo = (path: string): RepoRow =>
  ({ id: path, hostId: "h1", path, name: path.split("/").pop() ?? path }) as RepoRow;

/** A repository carries the only evidence that a pass ran, so fixtures date it. */
const scannedRepo = (path: string, at = "2026-08-02T14:30:00Z"): RepoRow =>
  ({ ...repo(path), lastSnapshotAt: at }) as RepoRow;

/** The exact sentence the agent builds (`joinNames`), so the parser is tested against it. */
const rootMissing = (...paths: string[]): AgentDiagnostic =>
  warn("git.root_missing", `Configured git root is missing or not a checkout: ${paths.join(", ")}`);

describe("[TC-PDHOST-021] which git root the agent could not find", () => {
  it("names only the roots the message lists", () => {
    expect([...missingGitRoots([rootMissing("/srv/work")])]).toEqual(["/srv/work"]);
    expect(missingGitRoots([]).size).toBe(0);
  });

  it("does not blame a parent path for its child's absence", () => {
    // ⚠ THE BUG A SUBSTRING TEST WOULD HAVE. "/srv" is a prefix of "/srv/work",
    // so `message.includes(root.path)` marks the working root red — on a screen
    // whose only job is telling somebody which row they mistyped.
    const missing = missingGitRoots([rootMissing("/srv/work")]);
    expect(missing.has("/srv/work")).toBe(true);
    expect(missing.has("/srv")).toBe(false);
  });

  it("stays silent about roots the capped message dropped", () => {
    // The agent truncates a long list to "(+N more)". Those names are simply not
    // in the message, and an unnamed root must show its ordinary state — saying
    // nothing about a root that may be fine is recoverable, painting a working
    // root red is not.
    const diagnostics = [rootMissing("/a", "/b")];
    const capped: AgentDiagnostic[] = [
      warn("git.root_missing", `${diagnostics[0]!.message} (+3 more)`),
    ];
    const missing = missingGitRoots(capped);
    expect(missing.has("/a")).toBe(true);
    expect(missing.has("(+3 more)")).toBe(false);
    expect(missing.size).toBe(2);
  });
});

describe("[TC-PDHOST-021] repositories collected under a root", () => {
  it("counts the root itself, not only its children", () => {
    // `discover.go` walks one level each way: a root is either a checkout or a
    // directory of them. Matching only the second shape reports a zero count for the
    // single-checkout case, which is what most people set up first.
    expect(reposUnder("/srv/work", [repo("/srv/work")])).toBe(1);
    expect(reposUnder("/srv/work", [repo("/srv/work/a"), repo("/srv/work/b")])).toBe(2);
  });

  it("does not count a sibling whose name merely starts the same", () => {
    expect(reposUnder("/srv/work", [repo("/srv/work-old/a")])).toBe(0);
  });
});

describe("[TC-PDHOST-021] the status shown for each row", () => {
  const diagnostics = [rootMissing("/gone")];

  it("separates off, missing, found and empty", () => {
    const rows = gitRootRows(
      [root("/srv/work"), root("/gone"), root("/quiet"), root("/paused", false)],
      [scannedRepo("/srv/work/a")],
      diagnostics,
      NOW,
      INTERVAL,
    );
    expect(rows.map((row) => row.status)).toEqual(["found", "missing", "empty", "off"]);
    expect(rows[0]!.repoCount).toBe(1);
  });

  it("does not call a disabled root missing", () => {
    // Nothing is looking at a disabled root, so `gitRoots.missing` would be a claim about a
    // path nobody checked — the same rule the services card follows for "off".
    const rows = gitRootRows([root("/gone", false)], [], diagnostics, NOW, INTERVAL);
    expect(rows[0]!.status).toBe("off");
  });
});

describe("[TC-PDHOST-021] which sentence the git dock shows when it is empty", () => {
  it("blames the missing binary before the missing path", () => {
    // A host with neither has one cause worth acting on, and it is not the path:
    // pointing somebody at the settings screen to fix an uninstalled git sends
    // them somewhere that cannot help.
    expect(dockEmptyReason(0, [warn("git.missing", "git is not installed")])).toBe("no-git");
  });

  it("says nothing is configured only when nothing is", () => {
    expect(dockEmptyReason(0, [])).toBe("no-roots");
    // A host with no rows of its own is still on the fleet list, and the server
    // already resolved that into the count — so this is "configured, found none".
    expect(dockEmptyReason(1, [])).toBe("none-found");
  });
});

describe("[TC-PDHOST-023] a path nobody has scanned yet is not a path with nothing on it", () => {
  const justNow = new Date(NOW - 20_000).toISOString();

  it("says 'checking' inside the scan window instead of 'none'", () => {
    // ⚠ THE TWO-MINUTE LIE. Saving a path pushes a config immediately, but the
    // agent's git pass is a timer and a changed root list does NOT re-arm it —
    // `applyConfig` re-arms only when the INTERVAL changed. So the card claimed
    // `gitRoots.empty` — "I looked, there is nothing" — while nobody had looked.
    // Measured in production: saved 15:29:27, repositories collected 15:31:15.
    const rows = gitRootRows([root("/srv/new", true, justNow)], [], [], NOW, INTERVAL);
    expect(rows[0]!.status).toBe("pending");
  });

  it("stops saying it once the window has passed", () => {
    // `gitRoots.pending` that never expires is the same defect wearing a nicer word: an
    // empty result has to become a real answer, or a mistyped path never gets
    // called out at all.
    const old = new Date(NOW - (INTERVAL + 31) * 1000).toISOString();
    const rows = gitRootRows([root("/srv/new", true, old)], [], [], NOW, INTERVAL);
    expect(rows[0]!.status).toBe("empty");
  });

  it("trusts a completed pass over the clock", () => {
    // A pass that finished after the row was created covered this root, so an
    // empty result is a real answer even one second later.
    const rows = gitRootRows(
      [root("/srv/quiet", true, justNow)],
      [scannedRepo("/elsewhere/a", new Date(NOW - 5_000).toISOString())],
      [],
      NOW,
      INTERVAL,
    );
    expect(rows[0]!.status).toBe("empty");
  });

  it("does not un-answer a root that already produced repositories", () => {
    // ⚠ ADDING A SECOND ROOT MUST NOT TURN THE FIRST ONE BACK INTO A GUESS.
    // `found` outranks `pending`: repositories under a path are proof it was
    // looked at, whatever the clock says about the row beside it.
    const rows = gitRootRows(
      [root("/srv/work", true, justNow)],
      [scannedRepo("/srv/work/a", "2026-08-02T10:00:00Z")],
      [],
      NOW,
      INTERVAL,
    );
    expect(rows[0]!.status).toBe("found");
  });

  it("still calls a missing path missing, however fresh the row is", () => {
    // The agent has already answered about this one. Holding it at `gitRoots.pending`
    // would hide the typo this whole screen exists to surface.
    const rows = gitRootRows([root("/gone", true, justNow)], [], [rootMissing("/gone")], NOW, INTERVAL);
    expect(rows[0]!.status).toBe("missing");
  });
});
