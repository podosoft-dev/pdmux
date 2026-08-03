import { beforeEach, describe, expect, it } from "@jest/globals";
import {
  commitDetailSchema,
  gitRefSchema,
  repoSnapshotSchema,
  type CommitDetail,
  type GitRef,
  type RepoSnapshot,
} from "@pdmux/protocol";
import { FakeRepository } from "../testing/fake-repository";
import { FakeStorage } from "../testing/fake-storage";
import { GitDetailService } from "./git-detail.service";
import { GitIngestService, REPO_MISSING_GRACE_MS } from "./git-ingest.service";
import { commitDetailKey, workingDiffKey } from "./git-storage";
import { RepoCommit } from "./repo-commit.entity";
import { RepoRef } from "./repo-ref.entity";
import { Repo } from "./repo.entity";

const HOST = "11111111-1111-4111-8111-111111111111";
const SHA_A = "aaaaaaa1111111111111111111111111111111aa";
const SHA_B = "bbbbbbb2222222222222222222222222222222bb";
/** The replacement `git reset --soft` + re-commit produces for SHA_A. */
const SHA_C = "ccccccc3333333333333333333333333333333cc";
/** History older than a truncated window's oldest commit. */
const SHA_OLD = "ddddddd4444444444444444444444444444444dd";

function snapshot(overrides: Partial<RepoSnapshot> = {}): RepoSnapshot {
  // Parsed through the protocol schema so the fixture carries the same defaults an
  // agent's frame would.
  return repoSnapshotSchema.parse({
    path: "/srv/demo-repo",
    name: "demo-repo",
    ts: Math.floor(new Date("2026-07-25T10:00:00Z").getTime() / 1000),
    head: { branch: "main", sha: SHA_A, detached: false, upstream: "origin/main", ahead: 0, behind: 2 },
    refs: [{ name: "main", kind: "local", sha: SHA_A, upstream: "origin/main", ahead: 0, behind: 2 }],
    commits: [
      { sha: SHA_A, parents: [SHA_B], refs: ["HEAD -> main"], author: "dev", date: 1785000000, subject: "fix: thing" },
      { sha: SHA_B, parents: [], refs: [], author: "dev", date: 1784900000, subject: "feat: other" },
    ],
    uncommitted: { staged: 1, unstaged: 2, untracked: 0, conflicts: 0, total: 3, files: [], dropped: 0 },
    truncated: false,
    limit: 300,
    details: [{ sha: SHA_A, subject: "fix: thing", body: "body", files: [] }],
    workingDiff: { staged: [], unstaged: [], untracked: [], dropped: 0, truncated: false },
    pending: 1,
    error: null,
    ...overrides,
  });
}

/**
 * A local branch as the collector reports it. Built through the schema so the
 * fixture carries the same defaults (`gone`, null divergence) a frame would.
 */
function localRef(name: string, sha: string, extra: Record<string, unknown> = {}): GitRef {
  return gitRefSchema.parse({ name, kind: "local", sha, upstream: "origin/main", ...extra });
}

/** One commit detail, likewise defaulted by the schema rather than by hand. */
function detail(sha: string, subject: string, body: string): CommitDetail {
  return commitDetailSchema.parse({ sha, subject, body, files: [] });
}

function build(): {
  ingest: GitIngestService;
  repos: FakeRepository<Repo>;
  commits: FakeRepository<RepoCommit>;
  refs: FakeRepository<RepoRef>;
  storage: FakeStorage;
} {
  const repos = new FakeRepository<Repo>({
    hasWorkingDiff: false,
    pendingDetails: 0,
    limit: 300,
    missingSince: null,
  });
  const refs = new FakeRepository<RepoRef>();
  const commits = new FakeRepository<RepoCommit>({ hasDetail: false, detailEmpty: false, parents: [], refs: [] });
  const storage = new FakeStorage();
  const details = new GitDetailService(storage.asStorage());
  return {
    ingest: new GitIngestService(repos.asRepository(), refs.asRepository(), commits.asRepository(), details),
    repos,
    commits,
    refs,
    storage,
  };
}

type Ctx = ReturnType<typeof build>;

/** Stored commit shas, sorted so an assertion states a set rather than an order. */
function shas(ctx: Ctx): string[] {
  return (ctx.commits.rows as unknown as RepoCommit[]).map((commit) => commit.sha).sort();
}

function row(ctx: Ctx, sha: string): RepoCommit | undefined {
  return (ctx.commits.rows as unknown as RepoCommit[]).find((commit) => commit.sha === sha);
}

/** Every commit row still drawing a decoration for this ref name. */
function decorated(ctx: Ctx, name: string): string[] {
  return (ctx.commits.rows as unknown as RepoCommit[])
    .filter((commit) => commit.refs.some((ref) => ref === name || ref.endsWith(`> ${name}`)))
    .map((commit) => commit.sha)
    .sort();
}

describe("GitIngestService", () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = build();
  });

  it("[TC-PDGIT-001] ingests a snapshot once and re-ingests it for free", async () => {
    const first = await ctx.ingest.ingest(HOST, [snapshot()]);
    expect(first).toEqual({
      repos: 1,
      newCommits: 2,
      storedDetails: 1,
      skippedDetails: 0,
      prunedCommits: 0,
      prunedRepos: 0,
      repoPathsWithNewDetails: ["/srv/demo-repo"],
    });

    const repo = ctx.repos.rows[0] as unknown as Repo;
    expect(repo.headBranch).toBe("main");
    expect(repo.dirtyCount).toBe(3);
    expect(repo.pendingDetails).toBe(1);
    expect(ctx.storage.putCount(commitDetailKey(HOST, repo.id, SHA_A))).toBe(1);

    const second = await ctx.ingest.ingest(HOST, [snapshot()]);
    // A commit's patch cannot change, so a re-sent detail is skipped, not rewritten.
    // Nothing new was stored, so there is nothing to ack either.
    expect(second).toEqual({
      repos: 1,
      newCommits: 0,
      storedDetails: 0,
      skippedDetails: 1,
      prunedCommits: 0,
      prunedRepos: 0,
      repoPathsWithNewDetails: [],
    });
    expect(ctx.commits.rows).toHaveLength(2);
    expect(ctx.repos.rows).toHaveLength(1);
    expect(ctx.storage.putCount(commitDetailKey(HOST, repo.id, SHA_A))).toBe(1);
  });

  it("[TC-PDGIT-001] refreshes moving decorations without touching stored details", async () => {
    await ctx.ingest.ingest(HOST, [snapshot()]);
    const repo = ctx.repos.rows[0] as unknown as Repo;

    const moved = snapshot({
      commits: [
        { sha: SHA_A, parents: [SHA_B], refs: ["HEAD -> main", "origin/main"], author: "dev", date: 1785000000, subject: "fix: thing" },
        { sha: SHA_B, parents: [], refs: [], author: "dev", date: 1784900000, subject: "feat: other" },
      ].map((commit) => ({ ...commit })),
      details: [],
    });
    await ctx.ingest.ingest(HOST, [moved]);

    const row = (ctx.commits.rows as unknown as RepoCommit[]).find((c) => c.sha === SHA_A);
    expect(row?.refs).toEqual(["HEAD -> main", "origin/main"]);
    expect(row?.hasDetail).toBe(true);
    expect(ctx.storage.putCount(commitDetailKey(HOST, repo.id, SHA_A))).toBe(1);
  });

  it("[TC-PDGIT-004] rewrites the working diff every pass and removes it when the tree is clean", async () => {
    await ctx.ingest.ingest(HOST, [snapshot()]);
    const repo = ctx.repos.rows[0] as unknown as Repo;
    const key = workingDiffKey(HOST, repo.id);

    expect(repo.hasWorkingDiff).toBe(true);
    await ctx.ingest.ingest(HOST, [snapshot()]);
    // Mutable by definition: unlike a commit, this object IS rewritten.
    expect(ctx.storage.putCount(key)).toBe(2);

    await ctx.ingest.ingest(HOST, [snapshot({ workingDiff: null, uncommitted: null })]);
    expect(ctx.storage.deletes).toContain(key);
    expect((ctx.repos.rows[0] as unknown as Repo).hasWorkingDiff).toBe(false);
    expect((ctx.repos.rows[0] as unknown as Repo).dirtyCount).toBe(0);
  });

  it("[TC-PDGIT-006] a partial frame adds details without emptying the graph", async () => {
    await ctx.ingest.ingest(HOST, [snapshot()]);
    const before = ctx.repos.rows[0] as unknown as Repo;
    expect(before.pendingDetails).toBe(1);

    // What an agent sends when it answers a click: only `details`. Everything else
    // holds schema defaults — refs [], commits [], limit 300, head null.
    const partial = repoSnapshotSchema.parse({
      path: "/srv/demo-repo",
      name: "demo-repo",
      ts: Math.floor(new Date("2026-07-25T10:05:00Z").getTime() / 1000),
      partial: true,
      details: [{ sha: SHA_B, subject: "feat: other", body: "second body", files: [] }],
    });
    const summary = await ctx.ingest.ingest(HOST, [partial]);

    expect(summary).toMatchObject({ repos: 1, newCommits: 0, storedDetails: 1, skippedDetails: 0 });
    expect(summary.repoPathsWithNewDetails).toEqual(["/srv/demo-repo"]);

    const after = ctx.repos.rows[0] as unknown as Repo;
    // The graph the click was made against is untouched.
    expect(ctx.refs.rows).toHaveLength(1);
    expect(ctx.commits.rows).toHaveLength(2);
    expect(after.headBranch).toBe("main");
    expect(after.dirtyCount).toBe(3);
    expect(after.limit).toBe(300);
    expect(after.hasWorkingDiff).toBe(true);
    // One fewer commit is waiting for its patch.
    expect(after.pendingDetails).toBe(0);
    expect((ctx.commits.rows as unknown as RepoCommit[]).find((c) => c.sha === SHA_B)?.hasDetail).toBe(true);
    expect(ctx.storage.putCount(commitDetailKey(HOST, after.id, SHA_B))).toBe(1);
  });

  it("[TC-PDGIT-006] ignores a partial frame for a checkout it has never seen", async () => {
    const orphan = repoSnapshotSchema.parse({
      path: "/nowhere",
      name: "nowhere",
      ts: 1785000000,
      partial: true,
      details: [{ sha: SHA_A, subject: "x", body: "y", files: [] }],
    });

    const summary = await ctx.ingest.ingest(HOST, [orphan]);
    expect(summary.storedDetails).toBe(0);
    // Creating a row here would invent a repo whose every field is a default.
    expect(ctx.repos.rows).toHaveLength(0);
    expect(ctx.storage.puts).toEqual([]);
  });

  it("[TC-PDGIT-007] records moved submodule pointers separately from file changes", async () => {
    await ctx.ingest.ingest(HOST, [
      snapshot({
        uncommitted: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0, submodules: 2, total: 2, files: [], dropped: 0 },
      }),
    ]);

    const repo = ctx.repos.rows[0] as unknown as Repo;
    // A dirty submodule is invisible in the file list yet is what makes a "clean"
    // checkout commit something unexpected.
    expect(repo.dirtySubmodules).toBe(2);
    expect(repo.dirtyCount).toBe(2);
  });

  it("[TC-PDGIT-005] isolates a failing repo from the healthy ones in the same frame", async () => {
    const broken = snapshot({
      path: "/home/ubuntu/broken",
      name: "broken",
      error: "not a git checkout",
      refs: [],
      commits: [],
      details: [],
      workingDiff: null,
    });

    const summary = await ctx.ingest.ingest(HOST, [broken, snapshot()]);
    expect(summary.repos).toBe(2);
    expect(summary.newCommits).toBe(2);

    const rows = ctx.repos.rows as unknown as Repo[];
    expect(rows.find((repo) => repo.name === "broken")?.error).toBe("not a git checkout");
    expect(rows.find((repo) => repo.name === "demo-repo")?.error).toBeNull();
  });

  // -------------------------------------------------------------------------
  // The reported window is authoritative (TC-PDGIT-009)
  //
  // Measured on a live fleet: the store held 62 commits for a repository whose
  // window reported ~55, because every snapshot was unioned into what was already
  // there. Two of the extra rows were shas a `git reset --soft` plus a re-commit
  // had abandoned — drawn next to their replacements, one of them still wearing
  // the `main` chip it had when it was HEAD.
  // -------------------------------------------------------------------------

  /** The shape of the live defect: SHA_A abandoned, SHA_C committed in its place. */
  function rewritten(overrides: Partial<RepoSnapshot> = {}): RepoSnapshot {
    return snapshot({
      head: { branch: "main", sha: SHA_C, detached: false, upstream: "origin/main", ahead: 1, behind: 0 },
      refs: [localRef("main", SHA_C, { ahead: 1, behind: 0 })],
      commits: [
        { sha: SHA_C, parents: [SHA_B], refs: ["HEAD -> main"], author: "dev", date: 1785000100, subject: "fix: thing" },
        { sha: SHA_B, parents: [], refs: [], author: "dev", date: 1784900000, subject: "feat: other" },
      ],
      details: [detail(SHA_C, "fix: thing", "body")],
      ...overrides,
    });
  }

  it("[TC-PDGIT-009] forgets a commit the window stopped reporting, and its patch with it", async () => {
    await ctx.ingest.ingest(HOST, [snapshot()]);
    const repo = ctx.repos.rows[0] as unknown as Repo;
    expect(shas(ctx)).toEqual([SHA_A, SHA_B]);

    const summary = await ctx.ingest.ingest(HOST, [rewritten()]);

    // The abandoned sha is gone rather than unioned in beside its replacement.
    expect(shas(ctx)).toEqual([SHA_B, SHA_C]);
    expect(summary.prunedCommits).toBe(1);
    expect(summary.newCommits).toBe(1);
    // Its patch is unreachable once the row is gone, so it is not left behind.
    expect(ctx.storage.deletes).toContain(commitDetailKey(HOST, repo.id, SHA_A));
    expect(ctx.storage.objects.has(commitDetailKey(HOST, repo.id, SHA_A))).toBe(false);
  });

  it("[TC-PDGIT-009] keeps the stored detail of every sha still in the window", async () => {
    // Both commits arrive with a patch; only one of them is later rewritten away.
    await ctx.ingest.ingest(HOST, [
      snapshot({
        details: [detail(SHA_A, "fix: thing", "body"), detail(SHA_B, "feat: other", "second body")],
      }),
    ]);
    const repo = ctx.repos.rows[0] as unknown as Repo;
    const kept = commitDetailKey(HOST, repo.id, SHA_B);

    await ctx.ingest.ingest(HOST, [rewritten()]);

    // A prune is not a reason to re-collect a neighbour: SHA_B's patch is untouched,
    // written once and never deleted, and its row still says so.
    expect(ctx.storage.putCount(kept)).toBe(1);
    expect(ctx.storage.deletes).not.toContain(kept);
    expect(row(ctx, SHA_B)?.hasDetail).toBe(true);
  });

  it("[TC-PDGIT-009] draws a moved ref on its new commit only", async () => {
    await ctx.ingest.ingest(HOST, [snapshot()]);
    expect(row(ctx, SHA_A)?.refs).toEqual(["HEAD -> main"]);

    // (a) the ref moves to a commit that replaced the one it was on: the old row —
    // and the stale decoration with it — leaves the graph.
    await ctx.ingest.ingest(HOST, [rewritten()]);
    expect(decorated(ctx, "main")).toEqual([SHA_C]);
    expect((ctx.refs.rows as unknown as RepoRef[]).map((ref) => `${ref.name}@${ref.sha}`)).toEqual([
      `main@${SHA_C}`,
    ]);

    // (b) the ref moves BACKWARDS onto a commit that is still in the window: the row
    // stays, so the decoration itself has to be cleared.
    await ctx.ingest.ingest(HOST, [
      rewritten({
        head: { branch: "main", sha: SHA_B, detached: false, upstream: "origin/main", ahead: 0, behind: 1 },
        refs: [localRef("main", SHA_B, { ahead: 0, behind: 1 })],
        commits: [
          { sha: SHA_C, parents: [SHA_B], refs: [], author: "dev", date: 1785000100, subject: "fix: thing" },
          { sha: SHA_B, parents: [], refs: ["HEAD -> main"], author: "dev", date: 1784900000, subject: "feat: other" },
        ],
        details: [],
      }),
    ]);
    expect(decorated(ctx, "main")).toEqual([SHA_B]);
  });

  it("[TC-PDGIT-009] prunes nothing from a partial frame", async () => {
    await ctx.ingest.ingest(HOST, [snapshot()]);

    // `partial: true` answers one click and carries ONLY details — its empty
    // `commits` is a schema default. Reading it as a window would erase the graph.
    const partial = repoSnapshotSchema.parse({
      path: "/srv/demo-repo",
      name: "demo-repo",
      ts: Math.floor(new Date("2026-07-25T10:05:00Z").getTime() / 1000),
      partial: true,
      details: [{ sha: SHA_B, subject: "feat: other", body: "second body", files: [] }],
    });
    const summary = await ctx.ingest.ingest(HOST, [partial]);

    expect(summary.prunedCommits).toBe(0);
    expect(shas(ctx)).toEqual([SHA_A, SHA_B]);
    expect(ctx.storage.deletes).toEqual([]);
  });

  it("[TC-PDGIT-009] prunes nothing when the window reports no commits at all", async () => {
    await ctx.ingest.ingest(HOST, [snapshot()]);

    // A `git log` that timed out on a stalled mount and an unborn HEAD are the same
    // frame from here, and only one of them means the history is gone.
    const summary = await ctx.ingest.ingest(HOST, [snapshot({ commits: [], details: [] })]);

    expect(summary.prunedCommits).toBe(0);
    expect(shas(ctx)).toEqual([SHA_A, SHA_B]);
  });

  it("[TC-PDGIT-009] reconciles inside a truncated window and leaves older history alone", async () => {
    // Seed three commits, the oldest of which a later, truncated window will not reach.
    await ctx.ingest.ingest(HOST, [
      snapshot({
        commits: [
          { sha: SHA_A, parents: [SHA_B], refs: ["HEAD -> main"], author: "dev", date: 1785000000, subject: "fix: thing" },
          { sha: SHA_B, parents: [SHA_OLD], refs: [], author: "dev", date: 1784900000, subject: "feat: other" },
          { sha: SHA_OLD, parents: [], refs: [], author: "dev", date: 1784000000, subject: "chore: begin" },
        ],
        details: [detail(SHA_A, "fix: thing", "body"), detail(SHA_OLD, "chore: begin", "first")],
      }),
    ]);
    const repo = ctx.repos.rows[0] as unknown as Repo;
    const ancient = commitDetailKey(HOST, repo.id, SHA_OLD);

    // The window now stops at SHA_B: SHA_A was rewritten away INSIDE it, SHA_OLD
    // simply fell out the bottom.
    const summary = await ctx.ingest.ingest(HOST, [rewritten({ truncated: true })]);

    expect(summary.prunedCommits).toBe(1);
    expect(shas(ctx)).toEqual([SHA_B, SHA_C, SHA_OLD]);
    // Older than everything the window looked at, so "absent" says nothing about it —
    // and its patch is one the agent will not offer again unaided.
    expect(row(ctx, SHA_OLD)?.hasDetail).toBe(true);
    expect(ctx.storage.deletes).not.toContain(ancient);
    expect(ctx.storage.deletes).toContain(commitDetailKey(HOST, repo.id, SHA_A));
  });

  it("[TC-PDGIT-009] prunes nothing from a window whose commits carry no dates", async () => {
    await ctx.ingest.ingest(HOST, [snapshot()]);

    // No date anywhere means no floor, and a truncated window with no floor cannot
    // tell "rewritten away" from "older than what I read".
    const summary = await ctx.ingest.ingest(HOST, [
      snapshot({
        truncated: true,
        commits: [{ sha: SHA_C, parents: [], refs: ["HEAD -> main"], author: "dev", date: null, subject: "fix: thing" }],
        details: [],
      }),
    ]);

    expect(summary.prunedCommits).toBe(0);
    expect(shas(ctx)).toEqual([SHA_A, SHA_B, SHA_C]);
  });

  it("[TC-PDGIT-009] prunes nothing when the collector reported an error", async () => {
    await ctx.ingest.ingest(HOST, [snapshot()]);

    const summary = await ctx.ingest.ingest(HOST, [
      snapshot({ error: "not a git checkout", refs: [], commits: [], details: [], workingDiff: null }),
    ]);

    expect(summary.prunedCommits).toBe(0);
    expect(shas(ctx)).toEqual([SHA_A, SHA_B]);
    expect((ctx.repos.rows[0] as unknown as Repo).error).toBe("not a git checkout");
  });

  it("[TC-PDGIT-001] replaces refs wholesale so a deleted branch disappears", async () => {
    await ctx.ingest.ingest(HOST, [snapshot()]);
    expect(ctx.refs.rows).toHaveLength(1);

    await ctx.ingest.ingest(HOST, [
      snapshot({
        refs: [
          { name: "release", kind: "local", sha: SHA_B, upstream: null, ahead: null, behind: null, gone: false },
          // Upstream deleted on the remote: the flag has to survive the round trip,
          // because "gone" and "0 behind" look identical without it.
          { name: "origin/main", kind: "remote", sha: SHA_A, upstream: null, ahead: null, behind: null, gone: true },
        ],
      }),
    ]);

    const refs = ctx.refs.rows as unknown as RepoRef[];
    expect(refs.map((ref) => ref.name).sort()).toEqual(["origin/main", "release"]);
    expect(refs.find((ref) => ref.name === "origin/main")?.gone).toBe(true);
  });
});

describe("GitIngestService repo reconciliation", () => {
  let ctx: Ctx;
  const OTHER = "/srv/other-repo";
  const other = (overrides: Partial<RepoSnapshot> = {}): RepoSnapshot =>
    snapshot({ path: OTHER, name: "other-repo", ...overrides });
  const paths = (): string[] => (ctx.repos.rows as unknown as Repo[]).map((repo) => repo.path).sort();
  const repoAt = (path: string): Repo | undefined =>
    (ctx.repos.rows as unknown as Repo[]).find((repo) => repo.path === path);

  beforeEach(async () => {
    ctx = build();
    await ctx.ingest.ingest(HOST, [snapshot(), other()]);
  });

  it("[TC-PDGIT-012] marks a checkout the report dropped, and keeps it", async () => {
    const result = await ctx.ingest.ingest(HOST, [snapshot()]);
    // Marked, NOT deleted: one absence is a slow discovery pass as easily as a deletion.
    expect(result.prunedRepos).toBe(0);
    expect(paths()).toEqual(["/srv/demo-repo", OTHER]);
    expect(repoAt(OTHER)?.missingSince).toBeInstanceOf(Date);
    expect(repoAt("/srv/demo-repo")?.missingSince).toBeNull();
  });

  it("[TC-PDGIT-012] forgets the mark when the checkout comes back", async () => {
    await ctx.ingest.ingest(HOST, [snapshot()]);
    expect(repoAt(OTHER)?.missingSince).toBeInstanceOf(Date);

    await ctx.ingest.ingest(HOST, [snapshot(), other()]);
    // Or a mark from weeks ago would sweep a repo that has been healthy ever since.
    expect(repoAt(OTHER)?.missingSince).toBeNull();
  });

  it("[TC-PDGIT-012] drops it once it has been gone past the grace period", async () => {
    const doomed = repoAt(OTHER)!;
    const detailKey = commitDetailKey(HOST, doomed.id, SHA_A);
    const diffKey = workingDiffKey(HOST, doomed.id);
    expect(ctx.storage.objects.has(detailKey)).toBe(true);

    await ctx.ingest.ingest(HOST, [snapshot()]);
    // Stand in for the wait: the row was marked, and the clock has since moved past the
    // grace. Only a LATER report can act on the mark, which is the actual guarantee.
    doomed.missingSince = new Date(Date.now() - REPO_MISSING_GRACE_MS - 1_000);

    const result = await ctx.ingest.ingest(HOST, [snapshot()]);
    expect(result.prunedRepos).toBe(1);
    expect(paths()).toEqual(["/srv/demo-repo"]);
    // Everything derived from it goes too — rows first, then the objects they claimed.
    expect((ctx.commits.rows as unknown as RepoCommit[]).every((c) => c.repoId !== doomed.id)).toBe(true);
    expect((ctx.refs.rows as unknown as RepoRef[]).every((r) => r.repoId !== doomed.id)).toBe(true);
    expect(ctx.storage.deletes).toContain(detailKey);
    expect(ctx.storage.deletes).toContain(diffKey);
    // The surviving repo is untouched.
    expect(repoAt("/srv/demo-repo")).toBeDefined();
    expect((ctx.commits.rows as unknown as RepoCommit[]).length).toBe(2);
  });

  it("[TC-PDGIT-012] reconciles nothing from an empty frame", async () => {
    // Zero repos is "this host has no checkouts" and "discovery failed or timed out",
    // and the two are indistinguishable here. Only one of them means they are gone.
    const result = await ctx.ingest.ingest(HOST, []);
    expect(result.prunedRepos).toBe(0);
    expect(paths()).toEqual(["/srv/demo-repo", OTHER]);
    expect(repoAt(OTHER)?.missingSince).toBeNull();
  });

  it("[TC-PDGIT-012] reconciles nothing from a frame carrying a partial", async () => {
    // A partial answers a click with ONE repo's patch. Read as a repo list it says every
    // other checkout on the host has vanished — which would empty the dashboard.
    const result = await ctx.ingest.ingest(HOST, [snapshot({ partial: true, commits: [], details: [] })]);
    expect(result.prunedRepos).toBe(0);
    expect(paths()).toEqual(["/srv/demo-repo", OTHER]);
    expect(repoAt(OTHER)?.missingSince).toBeNull();
  });

  it("[TC-PDGIT-012] never sweeps on the same report that marked it", async () => {
    // The mark is written with the server's clock, so it can never be old enough to act
    // on in the same pass — the sweep needs a later report by construction.
    await ctx.ingest.ingest(HOST, [snapshot()]);
    const result = await ctx.ingest.ingest(HOST, [snapshot()]);
    expect(result.prunedRepos).toBe(0);
    expect(paths()).toEqual(["/srv/demo-repo", OTHER]);
  });
});
