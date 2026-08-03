import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, IsNull, MoreThan, Not, Repository, type FindOptionsWhere } from "typeorm";
import type { RepoSnapshot } from "@pdmux/protocol";
import { GitDetailService } from "./git-detail.service";
import { isValidSha } from "./git-storage";
import { RepoCommit } from "./repo-commit.entity";
import { RepoRef } from "./repo-ref.entity";
import { Repo } from "./repo.entity";

export interface GitIngestSummary {
  repos: number;
  newCommits: number;
  storedDetails: number;
  /** Details the agent re-sent for a sha that already had one. */
  skippedDetails: number;
  /** Commit rows dropped because the reported window no longer contains them. */
  prunedCommits: number;
  /** Repo rows dropped because the host stopped reporting the checkout at all. */
  prunedRepos: number;
  /** Repos that received new details in this frame — the ones worth acking. */
  repoPathsWithNewDetails: string[];
}

/**
 * The floor below which "absent from this snapshot" stops meaning "gone from git".
 *
 * A truncated window looked at the newest `limit` commits and nothing older, so a
 * stored row older than everything it reported was never in scope for it. Returns
 * null when the window carries no dated commit at all — nothing can be placed
 * against a floor that does not exist, and guessing one would prune real history.
 */
export function windowFloor(commits: readonly { date: number | null }[]): Date | null {
  let oldest: number | null = null;
  for (const commit of commits) {
    if (commit.date === null) continue;
    if (oldest === null || commit.date < oldest) oldest = commit.date;
  }
  return oldest === null ? null : new Date(oldest * 1000);
}

/** Rows are deleted in batches for the same reason they are inserted in batches. */
const PRUNE_CHUNK = 200;

/**
 * How long a checkout may be absent from its host's report before the row is dropped.
 *
 * Deliberately many multiples of the default 120s collection interval: the cost of
 * waiting is a stale entry nobody is looking at, and the cost of being too eager is a
 * live repository's history deleted because one discovery pass was slow. Combined with
 * "mark on one report, sweep on a later one", a row survives any single bad pass at any
 * configured interval.
 */
export const REPO_MISSING_GRACE_MS = 30 * 60_000;

/** What one repo of a frame contributed, before it is folded into the summary. */
interface IngestOneResult {
  newCommits: number;
  storedDetails: number;
  skippedDetails: number;
  prunedCommits: number;
}

/** Frozen: it is returned to a caller that only folds it into a running total. */
const EMPTY_RESULT: IngestOneResult = Object.freeze({
  newCommits: 0,
  storedDetails: 0,
  skippedDetails: 0,
  prunedCommits: 0,
});

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/**
 * Folds `repos` frames into the database + object storage.
 *
 * THE INVARIANT: a commit's detail is immutable. A sha's patch cannot change, so
 * once stored it is never rewritten — that is what makes a re-sent snapshot (a
 * reconnect, a restarted agent, a duplicated frame) free instead of a full
 * rewrite of every object on every pass.
 *
 * THE OTHER INVARIANT (and it is not the same one): a full snapshot's window is
 * AUTHORITATIVE over what the graph renders. Immutable-per-sha says never rewrite
 * a row; it does not say keep it forever. Storing a union of every window ever
 * reported drew commits that no longer exist in the repository — `git reset --soft`
 * plus a re-commit left the abandoned shas on screen next to their replacements,
 * with the `main` chip still on the abandoned one, because a row nobody mentions
 * again is also a row whose decoration is never refreshed again. See `pruneCommits`.
 */
@Injectable()
export class GitIngestService {
  private readonly logger = new Logger(GitIngestService.name);

  constructor(
    @InjectRepository(Repo) private readonly repos: Repository<Repo>,
    @InjectRepository(RepoRef) private readonly refs: Repository<RepoRef>,
    @InjectRepository(RepoCommit) private readonly commits: Repository<RepoCommit>,
    private readonly details: GitDetailService,
  ) {}

  async ingest(hostId: string, snapshots: RepoSnapshot[]): Promise<GitIngestSummary> {
    const summary: GitIngestSummary = {
      repos: 0,
      newCommits: 0,
      storedDetails: 0,
      skippedDetails: 0,
      prunedCommits: 0,
      prunedRepos: 0,
      repoPathsWithNewDetails: [],
    };
    for (const snapshot of snapshots) {
      try {
        const one = await this.ingestOne(hostId, snapshot);
        summary.repos += 1;
        summary.newCommits += one.newCommits;
        summary.storedDetails += one.storedDetails;
        summary.skippedDetails += one.skippedDetails;
        summary.prunedCommits += one.prunedCommits;
        if (one.storedDetails > 0) summary.repoPathsWithNewDetails.push(snapshot.path);
      } catch (error) {
        // One bad checkout must not discard the other repos in the same frame.
        this.logger.warn(`Ingest repo failed host=${hostId} path=${snapshot.path}: ${String(error)}`);
      }
    }
    summary.prunedRepos = await this.reconcileRepos(hostId, snapshots);
    return summary;
  }

  /**
   * Marks the checkouts this host stopped reporting, and drops the ones that have been
   * gone long enough.
   *
   * THE THIRD INVARIANT, and the one nothing enforced: a full report is authoritative
   * over WHICH REPOS EXIST, not merely over what is inside each one. Without this a
   * deleted or moved checkout kept its row forever, and kept it frozen — the ingest
   * paths that maintain `seq` only run for a repo that is still reported, so a dead
   * repo's graph silently degrades to ordering by author date (see `RepoCommit.seq`).
   *
   * THREE THINGS IT MUST NOT DO, each one a way to delete a live repository:
   *  - an EMPTY frame reconciles nothing. Zero repos is a host with no checkouts and a
   *    discovery pass that failed or timed out, and only one of those means "they are
   *    gone" — the same reasoning as `pruneCommits`.
   *  - a frame containing ANY `partial` snapshot reconciles nothing. A partial carries
   *    one repo's details in answer to a click; read as a repo list it says every other
   *    checkout on the host has vanished.
   *  - one absence never deletes. The row is marked on the first report that omits it
   *    and swept only by a LATER one, so no single slow or failed pass can take history
   *    with it.
   */
  private async reconcileRepos(hostId: string, snapshots: RepoSnapshot[]): Promise<number> {
    if (snapshots.length === 0) return 0;
    if (snapshots.some((snapshot) => snapshot.partial)) return 0;

    const reported = new Set(snapshots.map((snapshot) => snapshot.path));
    const rows = await this.repos.find({ where: { hostId } });
    const now = Date.now();
    let dropped = 0;

    for (const row of rows) {
      if (reported.has(row.path)) {
        // Back in the report: forget it was ever missing, or an old mark would sweep a
        // repo that has been healthy for weeks.
        if (row.missingSince !== null) await this.repos.update({ id: row.id }, { missingSince: null });
        continue;
      }
      if (row.missingSince === null) {
        await this.repos.update({ id: row.id }, { missingSince: new Date(now) });
        continue;
      }
      if (now - row.missingSince.getTime() < REPO_MISSING_GRACE_MS) continue;
      await this.dropRepo(row);
      dropped += 1;
    }
    return dropped;
  }

  /** Removes one repo and everything derived from it. */
  private async dropRepo(repo: Repo): Promise<void> {
    const commits = await this.commits.find({ where: { repoId: repo.id } });
    for (const ids of chunked(commits.map((row) => row.id), PRUNE_CHUNK)) {
      await this.commits.delete({ id: In(ids) });
    }
    await this.refs.delete({ repoId: repo.id });
    await this.repos.delete({ id: repo.id });
    // Objects AFTER rows, exactly as in `pruneCommits`: a crash in between leaves
    // unreachable garbage rather than a row claiming a patch that is no longer there.
    for (const row of commits) {
      if (row.hasDetail) await this.details.deleteCommitDetail(repo.hostId, repo.id, row.sha);
    }
    if (repo.hasWorkingDiff) await this.details.deleteWorkingDiff(repo.hostId, repo.id);
    this.logger.log(`Dropped repo absent from the report host=${repo.hostId} path=${repo.path}`);
  }

  private async ingestOne(hostId: string, snapshot: RepoSnapshot): Promise<IngestOneResult> {
    if (snapshot.partial) return this.ingestPartial(hostId, snapshot);

    const repo = await this.upsertRepo(hostId, snapshot);
    if (snapshot.error) {
      // A failing repo still gets its row updated (with the error) so the UI can
      // show why it is empty instead of silently dropping it from the list.
      //
      // ⚠ AND IT PRUNES NOTHING. A collector that could not read the checkout
      // reports no commits and no refs; treating that as "the window contains
      // nothing" would delete the graph because a mount was slow.
      return EMPTY_RESULT;
    }

    await this.replaceRefs(repo.id, snapshot);
    const { newCommits, detailState } = await this.upsertCommits(repo.id, snapshot);
    const prunedCommits = await this.pruneCommits(repo, snapshot);
    await this.clearStaleWindowPositions(repo.id, snapshot);
    const { storedDetails, skippedDetails } = await this.storeDetails(hostId, repo, snapshot, detailState);
    await this.storeWorkingDiff(hostId, repo, snapshot);

    return { newCommits, storedDetails, skippedDetails, prunedCommits };
  }

  /**
   * Deletes the commit rows this window did not mention — the step that makes the
   * reported window authoritative instead of cumulative.
   *
   * WHY DELETE AND NOT MARK: a commit ROW is derived data the agent re-sends in
   * full on every pass, so once it is out of the window it has no value — if it
   * ever returns, the next snapshot re-inserts it for free. A marker would instead
   * (a) leave the store growing forever, which is half of the reported defect, and
   * (b) put a predicate on every read path (graph, `collectedShas`, detail lookup),
   * where the first one forgotten reproduces exactly this bug. Deleting makes the
   * wrong state unrepresentable. The one thing a marker would buy — keeping an
   * immutable patch for a sha that comes back — is a single `git show` the agent
   * rebuilds on demand, and a click already forces that rebuild regardless of its
   * ack ledger.
   *
   * THREE THINGS IT MUST NOT DO, each one a way to erase a live graph:
   *  - a `partial: true` frame carries only `details`; it never reaches here
   *    (`ingestOne` routes it away) because its empty `commits` is a schema
   *    default, not an observation.
   *  - an empty window prunes nothing. An unborn HEAD reports zero commits, and so
   *    does a `git log` that timed out on a stalled mount; the two are
   *    indistinguishable here and only one of them means "the history is gone".
   *  - a `truncated` window only reconciles down to its own oldest commit. Older
   *    history was never in scope for it, and deleting it would throw away patches
   *    the agent will not offer again on its own (they are outside the window it
   *    collects details for).
   */
  private async pruneCommits(repo: Repo, snapshot: RepoSnapshot): Promise<number> {
    if (snapshot.commits.length === 0) return 0;

    // Details count as attested: the agent produced a patch for that sha in this
    // pass, which it only does for commits it can still see. Keeping them out of
    // the prune stops this pass deleting the row `storeDetails` is about to mark.
    const keep = new Set<string>(snapshot.commits.map((commit) => commit.sha));
    for (const detail of snapshot.details) keep.add(detail.sha);

    const where: FindOptionsWhere<RepoCommit> = { repoId: repo.id, sha: Not(In([...keep])) };
    if (snapshot.truncated) {
      const floor = windowFloor(snapshot.commits);
      if (!floor) return 0;
      // Strictly newer than the floor: a row dated exactly at the boundary may be a
      // sibling `--max-count` cut off mid-second, and sparing it costs one stale row
      // where deleting it costs a patch that cannot be recollected.
      where.date = MoreThan(floor);
    }

    const stale = await this.commits.find({ where });
    if (stale.length === 0) return 0;

    for (const ids of chunked(stale.map((row) => row.id), PRUNE_CHUNK)) {
      await this.commits.delete({ id: In(ids) });
    }
    // Objects AFTER rows, so a crash in between leaves unreachable garbage rather
    // than a row that claims a patch which is no longer there.
    for (const row of stale) {
      if (row.hasDetail) await this.details.deleteCommitDetail(repo.hostId, repo.id, row.sha);
    }
    this.logger.debug(
      `Pruned ${stale.length} commit(s) outside the window repo=${repo.path} truncated=${snapshot.truncated}`,
    );
    return stale.length;
  }

  /**
   * Takes the window position away from every row this window did not place.
   *
   * WHY IT IS NOT ENOUGH TO WRITE THE POSITIONS: `pruneCommits` deliberately spares
   * two kinds of row — history older than a `truncated` window's floor, and a sha
   * attested only by a detail. Those rows keep whatever index an EARLIER window gave
   * them, and an earlier window's index 295 sorts ahead of this window's index 299.
   * A stale number would therefore interleave old history into the middle of the
   * graph and, with `take: limit`, push a real window row off the end. NULL says the
   * truthful thing — "no window has placed this row" — and sorts behind every placed
   * row (see `GitService.graph`).
   *
   * An empty window clears nothing, for the same reason it prunes nothing: zero
   * commits is an unborn HEAD or a `git log` that timed out on a stalled mount, and
   * only one of those means the history is gone. `partial` frames never reach here.
   *
   * The `seq IS NOT NULL` predicate makes this free after the first pass: steady
   * state matches no rows at all.
   */
  private async clearStaleWindowPositions(repoId: string, snapshot: RepoSnapshot): Promise<void> {
    if (snapshot.commits.length === 0) return;
    const placed = snapshot.commits.map((commit) => commit.sha);
    await this.commits.update({ repoId, sha: Not(In(placed)), seq: Not(IsNull()) }, { seq: null });
  }

  /**
   * A `partial: true` frame answers a `commitDetail` request and carries ONLY
   * details — every other field holds schema defaults, not truth.
   *
   * WHY IT NEEDS ITS OWN PATH: the full path would read those defaults as facts
   * and wipe the graph — refs deleted (empty list), head nulled, `limit` reset to
   * 300, `dirtyCount`/`pending` zeroed — because a click asked for one patch.
   * Nothing here touches anything but the details and the pending counter.
   */
  private async ingestPartial(hostId: string, snapshot: RepoSnapshot): Promise<IngestOneResult> {
    const repo = await this.repos.findOne({ where: { hostId, path: snapshot.path } });
    if (!repo) {
      // No graph to attach to. Creating a row from a partial frame would invent a
      // repo whose every field is a default.
      this.logger.warn(`Partial repo frame for unknown checkout host=${hostId} path=${snapshot.path}`);
      return EMPTY_RESULT;
    }
    const detailState = await this.loadDetailState(repo.id, snapshot.details.map((detail) => detail.sha));
    const stored = await this.storeDetails(hostId, repo, snapshot, detailState);
    const patch: Partial<Repo> = { lastSnapshotAt: new Date(snapshot.ts * 1000) };
    if (stored.storedDetails > 0) {
      // The click's patch just arrived, so one fewer commit is waiting. Clamped at
      // 0: the authoritative count comes from the next full snapshot.
      patch.pendingDetails = Math.max(0, repo.pendingDetails - stored.storedDetails);
    }
    await this.repos.update({ id: repo.id }, patch);
    return { newCommits: 0, prunedCommits: 0, ...stored };
  }

  private async loadDetailState(repoId: string, shas: string[]): Promise<Map<string, boolean>> {
    const state = new Map<string, boolean>();
    if (shas.length === 0) return state;
    const rows = await this.commits.find({ where: { repoId, sha: In(shas) } });
    for (const row of rows) state.set(row.sha, row.hasDetail);
    return state;
  }

  private async upsertRepo(hostId: string, snapshot: RepoSnapshot): Promise<Repo> {
    const existing = await this.repos.findOne({ where: { hostId, path: snapshot.path } });
    const patch: Partial<Repo> = {
      hostId,
      path: snapshot.path,
      name: snapshot.name,
      headBranch: snapshot.head.branch,
      headSha: snapshot.head.sha,
      detached: snapshot.head.detached,
      ahead: snapshot.head.ahead,
      behind: snapshot.head.behind,
      dirtyCount: snapshot.uncommitted?.total ?? 0,
      dirtySubmodules: snapshot.uncommitted?.submodules ?? 0,
      truncated: snapshot.truncated,
      limit: snapshot.limit,
      pendingDetails: snapshot.pending,
      lastSnapshotAt: new Date(snapshot.ts * 1000),
      error: snapshot.error,
    };
    if (!existing) return this.repos.save(this.repos.create(patch));
    Object.assign(existing, patch);
    return this.repos.save(existing);
  }

  /** Refs are replaced wholesale: a deleted branch has to disappear, and the list
   *  is small (hundreds), so a diff would cost more than it saves. */
  private async replaceRefs(repoId: string, snapshot: RepoSnapshot): Promise<void> {
    await this.refs.delete({ repoId });
    if (snapshot.refs.length === 0) return;
    const rows = snapshot.refs.map((ref) =>
      this.refs.create({
        repoId,
        name: ref.name,
        kind: ref.kind,
        sha: ref.sha,
        upstream: ref.upstream,
        ahead: ref.ahead,
        behind: ref.behind,
        gone: ref.gone,
      }),
    );
    await this.refs.save(rows, { chunk: 200 });
  }

  private async upsertCommits(
    repoId: string,
    snapshot: RepoSnapshot,
  ): Promise<{ newCommits: number; detailState: Map<string, boolean> }> {
    const shas = snapshot.commits.map((c) => c.sha);
    const detailShas = snapshot.details.map((d) => d.sha);
    const known = new Set([...shas, ...detailShas]);
    const existing = known.size
      ? await this.commits.find({ where: { repoId, sha: In([...known]) } })
      : [];
    const bySha = new Map(existing.map((row) => [row.sha, row]));

    const inserts: RepoCommit[] = [];
    // The INDEX is the payload: `commits` arrives in `git log --date-order`, and
    // that order is what the graph has to be drawn in. Re-deriving it from `date`
    // (the AUTHOR date) cannot reproduce it — see `RepoCommit.seq`.
    for (const [index, commit] of snapshot.commits.entries()) {
      const row = bySha.get(commit.sha);
      if (!row) {
        inserts.push(
          this.commits.create({
            repoId,
            sha: commit.sha,
            parents: commit.parents,
            refs: commit.refs,
            author: commit.author,
            date: commit.date === null ? null : new Date(commit.date * 1000),
            subject: commit.subject,
            seq: index,
            hasDetail: false,
            detailEmpty: false,
          }),
        );
        continue;
      }
      // Decorations move — and so does a commit's PLACE, whenever history is
      // rewritten under it: a rebase reorders shas that already exist here, and one
      // new commit on top shifts every older row down by one. Everything else in a
      // commit row is immutable by definition.
      const patch: Partial<RepoCommit> = {};
      if (row.refs.join(" ") !== commit.refs.join(" ")) patch.refs = commit.refs;
      if (row.seq !== index) patch.seq = index;
      if (Object.keys(patch).length > 0) await this.commits.update({ id: row.id }, patch);
    }
    if (inserts.length > 0) await this.commits.save(inserts, { chunk: 200 });

    const detailState = new Map<string, boolean>();
    for (const row of existing) detailState.set(row.sha, row.hasDetail);
    for (const row of inserts) detailState.set(row.sha, false);
    return { newCommits: inserts.length, detailState };
  }

  private async storeDetails(
    hostId: string,
    repo: Repo,
    snapshot: RepoSnapshot,
    detailState: Map<string, boolean>,
  ): Promise<{ storedDetails: number; skippedDetails: number }> {
    let storedDetails = 0;
    let skippedDetails = 0;
    for (const detail of snapshot.details) {
      if (!isValidSha(detail.sha)) continue;
      if (detailState.get(detail.sha) === true) {
        skippedDetails += 1;
        continue;
      }
      await this.details.putCommitDetail(hostId, repo.id, detail);
      // The flag is written after the object exists, so a crash in between leaves
      // "not collected" (recollectable) rather than "collected but missing".
      await this.commits.update(
        { repoId: repo.id, sha: detail.sha },
        { hasDetail: true, detailEmpty: detail.empty },
      );
      storedDetails += 1;
    }
    return { storedDetails, skippedDetails };
  }

  private async storeWorkingDiff(hostId: string, repo: Repo, snapshot: RepoSnapshot): Promise<void> {
    if (snapshot.workingDiff) {
      // Mutable by definition — the working tree changes under your hands, so this
      // one object IS rewritten every pass.
      await this.details.putWorkingDiff(hostId, repo.id, snapshot.workingDiff);
      if (!repo.hasWorkingDiff) await this.repos.update({ id: repo.id }, { hasWorkingDiff: true });
      return;
    }
    if (repo.hasWorkingDiff) {
      await this.details.deleteWorkingDiff(hostId, repo.id);
      await this.repos.update({ id: repo.id }, { hasWorkingDiff: false });
    }
  }
}
