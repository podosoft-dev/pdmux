/**
 * The read-only commit dock's data.
 *
 * LIST AND DETAIL ARE SEPARATE REQUESTS, and that separation is the whole point
 * (ARCHITECTURE §4): the graph is rows only, and the body/file list/patch are
 * fetched by the click that asks for them. A click that lands on a commit whose
 * patch has not been collected yet gets `pending` — "still collecting (N left)" —
 * because returning nothing there taught users the feature was broken.
 *
 * THE CLICK IS ALSO WHAT ASKS FOR IT. The server answers a miss by requesting the
 * patch from the host agent, and it lands through ingest a second or two later. So a
 * miss with `pending > 0` is not an end state — `CommitDetailWatch` polls until it
 * arrives — and this class is only the `$state` mapping of that watch. The timing
 * rules live there because they have to be unit-testable, and vitest here runs without
 * the Svelte compiler.
 *
 * Nothing in this module can write to a repository: the API exposes no such route,
 * and the dock has no button for one.
 */
import type { CommitDetail, WorkingDiff } from "@pdmux/protocol";
import { UNCOMMITTED, type PendingNote, pendingNote } from "@pdmux/core";
import { errorCode, gitApi } from "./api";
import { CommitDetailWatch, type DetailWatchState } from "./commit-detail-watch";
import type { DetailResponse, RepoGraphResponse, RepoRow } from "./types";

export interface GitDockOptions {
  /** Overrides for the API calls, so a test needs no HTTP client. */
  api?: Partial<typeof gitApi>;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export class GitDock {
  hostId = $state<string | null>(null);
  repos = $state<RepoRow[]>([]);
  repoId = $state<string | null>(null);
  graph = $state<RepoGraphResponse | null>(null);
  selected = $state<string | null>(null);
  detail = $state<CommitDetail | null>(null);
  working = $state<WorkingDiff | null>(null);
  pending = $state<PendingNote | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);
  /**
   * Has a repository list actually come back for the host now selected?
   *
   * ⚠ NOT the same question as `repos.length === 0`, and the panel must not confuse
   * them. Between first paint and the response there is nothing in `repos`, and reading
   * that as "this host has no repositories" made the dock announce an empty result
   * roughly 600ms before it had asked anything — a wide column stating a fact that was
   * not yet in evidence, on every single refresh. Same mistake as reading a failed host
   * request as an empty fleet, one component over.
   */
  reposLoaded = $state(false);

  private readonly api: typeof gitApi;
  private readonly watch: CommitDetailWatch;

  constructor(options: GitDockOptions = {}) {
    this.api = { ...gitApi, ...(options.api ?? {}) };
    this.watch = new CommitDetailWatch({
      // The host/repo are read at call time on purpose: a poll must dial the pair the
      // dock is pointed at now, and switching either one cancels the watch anyway.
      fetch: (sha: string): Promise<DetailResponse<CommitDetail>> => {
        const hostId = this.hostId;
        const repoId = this.repoId;
        if (!hostId || !repoId) return Promise.reject(new Error("No repository selected"));
        return this.api.commitDetail(hostId, repoId, sha);
      },
      onChange: (state: DetailWatchState): void => this.applyDetailState(state),
      ...(options.schedule ? { schedule: options.schedule } : {}),
      ...(options.cancel ? { cancel: options.cancel } : {}),
    });
  }

  get repo(): RepoRow | null {
    return this.repos.find((row) => row.id === this.repoId) ?? null;
  }

  /** Point the dock at a host, keeping `preferredRepoId` when that repo still exists. */
  async openHost(hostId: string | null, preferredRepoId?: string | null): Promise<void> {
    this.hostId = hostId;
    this.repos = [];
    // A new host has been asked about, so nothing is known about its repositories yet.
    this.reposLoaded = false;
    this.clearSelection();
    this.graph = null;
    this.repoId = null;
    if (!hostId) return;
    try {
      this.repos = await this.api.repos(hostId);
      this.error = null;
    } catch (cause: unknown) {
      this.error = errorCode(cause);
      return;
    } finally {
      // Answered either way: an empty list is now a fact, and a failure has its own
      // message. Only the window before this point is "we do not know".
      this.reposLoaded = true;
    }
    const wanted = this.repos.find((row) => row.id === preferredRepoId) ?? this.repos[0];
    if (wanted) await this.openRepo(wanted.id);
  }

  async openRepo(repoId: string): Promise<void> {
    const hostId = this.hostId;
    if (!hostId) return;
    this.repoId = repoId;
    this.clearSelection();
    this.loading = true;
    try {
      this.graph = await this.api.graph(hostId, repoId);
      this.error = null;
    } catch (cause: unknown) {
      this.graph = null;
      this.error = errorCode(cause);
    } finally {
      this.loading = false;
    }
  }

  /**
   * A click on a row. The working-tree row and a commit row take different routes —
   * one is rewritten every pass, the other is immutable per sha.
   *
   * Clicking the row that is already open closes it: the detail panel takes a share
   * of the column, and the row that opened it is the obvious place to reach for when
   * you want the graph back.
   */
  async select(sha: string): Promise<void> {
    const hostId = this.hostId;
    const repoId = this.repoId;
    if (!hostId || !repoId) return;
    if (this.selected === sha) {
      this.clearSelection();
      return;
    }
    // A commit's patch may still be in flight from the previous selection; the watch
    // invalidates it here so a late answer cannot land on the row we are opening now.
    this.watch.stop();
    this.selected = sha;
    this.detail = null;
    this.working = null;
    this.pending = null;

    // The working tree is rewritten every collector pass and is never requested on
    // demand, so a miss there is a miss — nothing to wait for.
    if (sha !== UNCOMMITTED) {
      await this.watch.start(sha);
      return;
    }

    this.loading = true;
    try {
      const response = await this.api.workingDiff(hostId, repoId);
      this.working = response.detail;
      if (!response.available) this.pending = pendingNote({ pending: 0 }, sha);
      this.error = null;
    } catch (cause: unknown) {
      this.error = errorCode(cause);
      this.pending = pendingNote({ pending: 0 }, sha);
    } finally {
      this.loading = false;
    }
  }

  /** The panel's "try again" — a fresh polling budget for the commit already open. */
  async retryDetail(): Promise<void> {
    if (!this.selected || this.selected === UNCOMMITTED) return;
    await this.watch.retry();
  }

  clearSelection(): void {
    this.watch.stop();
    this.selected = null;
    this.detail = null;
    this.working = null;
    this.pending = null;
  }

  /**
   * The panel is going off screen (unmount, navigation) but the dock's state outlives
   * it — the shell keeps one instance so returning to the dashboard finds the same
   * repository and the same open commit. Polling for a panel nobody can see is exactly
   * the leak to avoid, so the wait ends here and the user gets a retry to press.
   */
  suspend(): void {
    this.watch.suspend();
  }

  /** Mirror one watch state onto the fields the panel reads. */
  private applyDetailState(state: DetailWatchState): void {
    // A commit's answer must never repaint the working-tree row, or a slow patch
    // arriving after the user moved on would blank the diff they are reading.
    if (state.sha !== null && state.sha !== this.selected) return;
    this.detail = state.detail;
    this.pending = state.pending;
    this.loading = state.loading;
  }
}
