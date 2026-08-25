import { beforeEach, describe, expect, it } from "bun:test";
import { repoSnapshotSchema, type RepoSnapshot } from "@pdmux/protocol";
import { AppException } from "../common/app-exception";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { HostGitRoot } from "../hosts/host-git-root.entity";
import { HostService } from "../hosts/host-service.entity";
import { Host } from "../hosts/host.entity";
import { HostsService } from "../hosts/hosts.service";
import { fakeAgentReleases } from "../testing/fake-agent-releases";
import { fakeDataSource } from "../testing/fake-data-source";
import { FakeRepository } from "../testing/fake-repository";
import { FakeStorage } from "../testing/fake-storage";
import { GitDetailService } from "./git-detail.service";
import { GitBlobBufferService } from "./git-blob-buffer.service";
import { GitIngestService } from "./git-ingest.service";
import { GitService } from "./git.service";
import { commitDetailKey } from "./git-storage";
import { RepoCommit } from "./repo-commit.entity";
import { RepoRef } from "./repo-ref.entity";
import { Repo } from "./repo.entity";

const ORG_A = "org-a";
const ORG_B = "org-b";
const COLLECTED = "aaaaaaa1111111111111111111111111111111aa";
const PENDING = "bbbbbbb2222222222222222222222222222222bb";

function snapshot(): RepoSnapshot {
  return repoSnapshotSchema.parse({
    path: "/srv/demo-repo",
    name: "demo-repo",
    ts: Math.floor(Date.now() / 1000),
    head: { branch: "main", sha: COLLECTED, detached: false },
    refs: [],
    commits: [
      { sha: COLLECTED, parents: [PENDING], refs: [], author: "dev", date: 1785000000, subject: "fix: thing" },
      { sha: PENDING, parents: [], refs: [], author: "dev", date: 1784900000, subject: "feat: other" },
    ],
    uncommitted: null,
    limit: 300,
    // Only one of the two commits has its patch collected so far.
    details: [{ sha: COLLECTED, subject: "fix: thing", body: "why", files: [] }],
    workingDiff: null,
    pending: 1,
  });
}

/**
 * A linear chain, newest first, exactly as `git log --date-order` reports one: each
 * row's parent is the row below it. `date` is the AUTHOR date, so a caller can make
 * it contradict the order — which is the whole point of the ordering tests.
 */
function windowSnapshot(
  rows: readonly { n: number; date: number }[],
  extra: Partial<RepoSnapshot> = {},
): RepoSnapshot {
  return repoSnapshotSchema.parse({
    path: "/srv/linear-repo",
    name: "linear-repo",
    ts: 1785100000,
    head: { branch: "main", sha: rows[0] ? windowSha(rows[0].n) : null, detached: false },
    refs: [],
    commits: rows.map((row, index) => ({
      sha: windowSha(row.n),
      parents: index + 1 < rows.length ? [windowSha(rows[index + 1]!.n)] : [],
      refs: [],
      author: "dev",
      date: row.date,
      subject: `commit ${row.n}`,
    })),
    uncommitted: null,
    limit: 300,
    details: [],
    workingDiff: null,
    pending: 0,
    ...extra,
  });
}

/** A 40-char hex sha that reads as its number, so a failed order names the commit. */
function windowSha(n: number): string {
  return n.toString(16).padStart(2, "0").repeat(20);
}

async function build(frames: RepoSnapshot[] = [snapshot()]): Promise<{
  git: GitService;
  ingest: GitIngestService;
  commits: FakeRepository<RepoCommit>;
  storage: FakeStorage;
  hostId: string;
  repoId: string;
}> {
  const hostRepo = new FakeRepository<Host>({ tags: [], capabilities: [], sortOrder: 0, enabled: true });
  const settings = new FleetSettingsService(new FakeRepository<FleetSetting>().asRepository());
  const gitRootRepo = new FakeRepository<HostGitRoot>();
  const hosts = new HostsService(
    hostRepo.asRepository(),
    new FakeRepository<HostService>().asRepository(),
    gitRootRepo.asRepository(),
    settings,
    fakeAgentReleases(),
    fakeDataSource(),
  );
  const host = await hosts.create(ORG_A, { label: "build-01" });

  const repos = new FakeRepository<Repo>({ hasWorkingDiff: false, pendingDetails: 0, limit: 300 });
  const refs = new FakeRepository<RepoRef>();
  const commits = new FakeRepository<RepoCommit>({ hasDetail: false, detailEmpty: false, parents: [], refs: [] });
  const storage = new FakeStorage();
  const details = new GitDetailService(storage.asStorage());
  const blobs = new GitBlobBufferService();
  const ingest = new GitIngestService(repos.asRepository(), refs.asRepository(), commits.asRepository(), details, blobs);
  for (const frame of frames) await ingest.ingest(host.id, [frame]);

  const git = new GitService(repos.asRepository(), refs.asRepository(), commits.asRepository(), details, blobs, hosts);
  return { git, ingest, commits, storage, hostId: host.id, repoId: (repos.rows[0] as unknown as Repo).id };
}

describe("GitService", () => {
  let ctx: Awaited<ReturnType<typeof build>>;

  beforeEach(async () => {
    ctx = await build();
  });

  it("[TC-PDGIT-002] answers 'not collected yet' with a pending count instead of an error", async () => {
    const ready = await ctx.git.commitDetail(ORG_A, ctx.hostId, ctx.repoId, COLLECTED);
    expect(ready.available).toBe(true);
    expect(ready.detail?.body).toBe("why");

    const notYet = await ctx.git.commitDetail(ORG_A, ctx.hostId, ctx.repoId, PENDING);
    expect(notYet).toEqual({ available: false, detail: null, pending: 1 });
  });

  it("[TC-PDGIT-002] treats a flagged-but-missing object as not collected", async () => {
    // The bucket was wiped under us: the honest answer is "not collected", which
    // also lets the next pass refill it.
    ctx.storage.objects.delete(commitDetailKey(ctx.hostId, ctx.repoId, COLLECTED));

    const result = await ctx.git.commitDetail(ORG_A, ctx.hostId, ctx.repoId, COLLECTED);
    expect(result.available).toBe(false);
  });

  it("[TC-PDGIT-002] rejects an unknown sha and an unknown repo, and scopes both", async () => {
    await expect(
      ctx.git.commitDetail(ORG_A, ctx.hostId, ctx.repoId, "ccccccc3333333333333333333333333333333cc"),
    ).rejects.toBeInstanceOf(AppException);
    await expect(ctx.git.commitDetail(ORG_A, ctx.hostId, ctx.repoId, "zz")).rejects.toBeInstanceOf(AppException);
    // Another organization cannot even learn that the repo exists.
    await expect(ctx.git.graph(ORG_B, ctx.hostId, ctx.repoId)).rejects.toBeInstanceOf(AppException);
    await expect(ctx.git.listRepos(ORG_B, ctx.hostId)).rejects.toBeInstanceOf(AppException);
  });

  it("[TC-PDGIT-002] returns graph rows without bodies or patches", async () => {
    const graph = await ctx.git.graph(ORG_A, ctx.hostId, ctx.repoId);

    expect(graph.commits.map((commit) => commit.sha)).toEqual([COLLECTED, PENDING]);
    expect(graph.commits[0]).toEqual({
      sha: COLLECTED,
      parents: [PENDING],
      refs: [],
      author: "dev",
      date: new Date(1785000000 * 1000).toISOString(),
      subject: "fix: thing",
      hasDetail: true,
    });
    expect(JSON.stringify(graph)).not.toContain("why");
  });

  it("[TC-PDGIT-002] reports no working diff for a clean tree", async () => {
    expect(await ctx.git.workingDiff(ORG_A, ctx.hostId, ctx.repoId)).toEqual({
      available: false,
      detail: null,
      pending: 0,
    });
  });
});

/**
 * The order the agent collected is the order the graph renders.
 *
 * The graph used to be read back ordered by `date` — the AUTHOR date — while the
 * agent collects the window with `git log --date-order`, which walks by COMMITTER
 * date. Every rebase, amend, cherry-pick or `reset --soft` + re-commit keeps the
 * author date and moves the committer date, so the two orders disagree and a parent
 * can be handed to the lane algorithm ahead of its child. That algorithm, by its
 * contract, reads a commit nothing is waiting for as a branch tip: a 60-commit,
 * 0-merge history drew as three branches on `local-dev`.
 */
describe("GitService window order", () => {
  const order = (rows: readonly { sha: string }[]): string[] => rows.map((row) => row.sha);

  it("[TC-PDGIT-010] renders the agent's order when the author dates contradict it", async () => {
    // Rows 3 and 4 are the measured shape: re-committed with their author dates
    // preserved, so `%at` puts them the other way round from `--date-order`.
    const ctx = await build([
      windowSnapshot([
        { n: 1, date: 1785000600 },
        { n: 2, date: 1785000500 },
        { n: 3, date: 1785000100 },
        { n: 4, date: 1785000400 },
        { n: 5, date: 1785000000 },
      ]),
    ]);

    const graph = await ctx.git.graph(ORG_A, ctx.hostId, ctx.repoId);
    expect(order(graph.commits)).toEqual([1, 2, 3, 4, 5].map(windowSha));

    // The fixture really is adversarial: re-deriving the order from the dates the
    // response still carries produces a DIFFERENT list. `date` stays for display.
    const byDate = [...graph.commits]
      .sort((left, right) => Date.parse(right.date!) - Date.parse(left.date!))
      .map((commit) => commit.sha);
    expect(byDate).not.toEqual(order(graph.commits));
    expect(graph.commits.every((commit) => commit.date !== null)).toBe(true);
  });

  it("[TC-PDGIT-010] moves every stored position when a commit lands on top", async () => {
    const ctx = await build([
      windowSnapshot([
        { n: 1, date: 1785000600 },
        { n: 2, date: 1785000500 },
        { n: 3, date: 1785000400 },
      ]),
    ]);
    // The fake repository keeps untyped rows, so the stored position comes back `unknown`.
    const seqOf = (n: number): unknown => ctx.commits.rows.find((row) => row.sha === windowSha(n))?.seq;
    expect(seqOf(1)).toBe(0);

    // One new commit on top shifts every older row down by one, and not one author date
    // changes. The stored position has to move with them; a row is updated in place,
    // never duplicated.
    //
    // ⚠ This fixture reorders NOTHING that is ancestor-related, because nothing can. A
    // sha's parents are part of its identity, so `upsertCommits` never rewrites them —
    // which means a window that transposes two commits of one chain does not describe a
    // rebase (a rebase mints new shas), it describes a feed contradicting itself. That
    // is the shape `stableTopoOrder` repairs, and it is measured in `commit-order.spec.ts`
    // rather than asserted here as if it were a legitimate order.
    await ctx.ingest.ingest(ctx.hostId, [
      windowSnapshot([
        { n: 4, date: 1785000700 },
        { n: 1, date: 1785000600 },
        { n: 2, date: 1785000500 },
        { n: 3, date: 1785000400 },
      ]),
    ]);

    const graph = await ctx.git.graph(ORG_A, ctx.hostId, ctx.repoId);
    expect(order(graph.commits)).toEqual([4, 1, 2, 3].map(windowSha));
    expect(ctx.commits.rows).toHaveLength(4);
    expect(seqOf(1)).toBe(1);
  });

  it("[TC-PDGIT-010] cuts at the window boundary, with unplaced history behind it", async () => {
    // A `truncated` window spares history older than its own floor — that patch
    // cannot be recollected — so the store legitimately holds more rows than the
    // window, and they must not take a slot the window needs.
    const ctx = await build([
      windowSnapshot(
        [
          { n: 1, date: 1785000500 },
          { n: 2, date: 1785000400 },
          { n: 3, date: 1785000300 },
          { n: 4, date: 1785000200 },
          { n: 5, date: 1785000100 },
        ],
        { truncated: true, limit: 5 },
      ),
    ]);

    // The window moves on and narrows: two new commits, limit 3.
    await ctx.ingest.ingest(ctx.hostId, [
      windowSnapshot(
        [
          { n: 6, date: 1785000700 },
          { n: 7, date: 1785000600 },
          { n: 1, date: 1785000500 },
        ],
        { truncated: true, limit: 3 },
      ),
    ]);

    const graph = await ctx.git.graph(ORG_A, ctx.hostId, ctx.repoId);
    expect(order(graph.commits)).toEqual([6, 7, 1].map(windowSha));
    // The cut is the window, not the store: the spared rows are still there…
    expect(ctx.commits.rows).toHaveLength(7);
    // …and they hold NO position, so an index from the older window can never sort
    // itself into the middle of this one.
    const placed = new Set([6, 7, 1].map(windowSha));
    const spared = ctx.commits.rows.filter((row) => !placed.has(row.sha as string));
    expect(spared.map((row) => row.seq)).toEqual([null, null, null, null]);
  });

  it("[TC-PDGIT-010] leaves stored positions alone when a window reports nothing", async () => {
    const ctx = await build([
      windowSnapshot([
        { n: 1, date: 1785000600 },
        { n: 2, date: 1785000500 },
      ]),
    ]);

    // Zero commits is an unborn HEAD or a `git log` that timed out on a stalled
    // mount. Neither is an observation that the order changed.
    await ctx.ingest.ingest(ctx.hostId, [windowSnapshot([])]);

    const graph = await ctx.git.graph(ORG_A, ctx.hostId, ctx.repoId);
    expect(order(graph.commits)).toEqual([1, 2].map(windowSha));
    expect(ctx.commits.rows.map((row) => row.seq)).toEqual([0, 1]);
  });
});
