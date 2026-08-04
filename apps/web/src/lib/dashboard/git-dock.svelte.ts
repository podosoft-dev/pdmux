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
import type { CommitDetail, GitBlob, GitTree, WorkingDiff } from "@pdmux/protocol";
import { UNCOMMITTED, type PendingNote, pendingNote } from "@pdmux/core";
import { errorCode, gitApi } from "./api";
import { CommitDetailWatch, type DetailWatchState } from "./commit-detail-watch";
import { GitFileCache } from "./git-file-cache.svelte";
import type { DetailResponse, RepoGraphResponse, RepoRow } from "./types";

export interface GitDockOptions {
  /** Overrides for the API calls, so a test needs no HTTP client. */
  api?: Partial<typeof gitApi>;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/**
 * How long a click waits for a file listing or a file.
 *
 * The agent answers with one `ls-tree` or one `show`, so a live one is back in
 * well under a second. The budget is sized for the other case — an agent too old
 * to know the frame, which logs it and never replies — where the point is to reach
 * a sentence on screen rather than a spinner that never stops.
 */
export const FILE_POLL_ATTEMPTS = 8;
export const FILE_POLL_DELAY_MS = 600;

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

  /**
   * The `File tree` face: the listing for the open commit, and the file being read.
   *
   * ⚠ NEITHER IS FETCHED UNTIL THAT FACE IS OPENED, and the file not until it is
   * clicked. A listing is a few thousand names and the files under it are the whole
   * repository — collecting them with the graph would be the largest thing this
   * dashboard ever sent, for content most sessions never look at.
   */
  tree = $state<GitTree | null>(null);
  treeLoading = $state(false);
  /** Set when the listing is not coming: an agent too old, or one not answering. */
  treeUnavailable = $state(false);
  filePath = $state<string | null>(null);
  fileBlob = $state<GitBlob | null>(null);
  fileLoading = $state(false);
  fileUnavailable = $state(false);

  private readonly api: typeof gitApi;
  private readonly watch: CommitDetailWatch;
  /** Bounded, self-expiring, and emptied when the view goes away. */
  private readonly files = new GitFileCache();
  /** Injected so a spec does not wait real seconds between polls. */
  private readonly scheduleFn: (fn: () => void, ms: number) => unknown;
  /** Bumped by anything that makes an in-flight tree or file answer irrelevant. */
  private fileGeneration = 0;
  /** The sha whose listing we already gave up on — so we do not start over. */
  private treeFailedFor: string | null = null;

  constructor(options: GitDockOptions = {}) {
    this.api = { ...gitApi, ...(options.api ?? {}) };
    this.scheduleFn = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
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
    this.clearFileState();
  }

  /**
   * Open the `File tree` face for the commit already selected.
   *
   * ⚠ CALLED BY THE TAB, NOT BY THE CLICK THAT SELECTED THE COMMIT. That is the
   * whole lazy-loading rule in one line: opening a commit costs a patch, and only
   * asking for the tree costs a tree.
   */
  async ensureTree(): Promise<void> {
    const hostId = this.hostId;
    const repoId = this.repoId;
    const sha = this.selected;
    if (!hostId || !repoId || !sha || sha === UNCOMMITTED) return;
    if (this.tree?.sha === sha || this.treeLoading) return;
    // ⚠ AND NOT AGAIN AFTER GIVING UP. An agent too old never answers, so a caller
    // that re-enters on every state change restarts the budget forever — which is
    // exactly what happened before the effect above it was untracked. Remembering
    // the sha stops it; a different commit still asks.
    if (this.treeFailedFor === sha) return;

    const cached = this.files.getTree(repoId, sha);
    if (cached) {
      this.tree = cached;
      this.treeUnavailable = false;
      return;
    }

    const generation = ++this.fileGeneration;
    this.treeLoading = true;
    this.treeUnavailable = false;
    try {
      const value = await this.pollFor(
        () => this.api.commitTree(hostId, repoId, sha),
        generation,
      );
      if (generation !== this.fileGeneration) return;
      if (value) {
        this.files.putTree(repoId, sha, value);
        this.tree = value;
      } else {
        // Nothing is coming. The agent may be too old to know the frame at all —
        // it logs and keeps its socket rather than answering — so the screen has
        // to say so instead of spinning forever.
        this.treeUnavailable = true;
        this.treeFailedFor = sha;
      }
    } catch (cause: unknown) {
      if (generation !== this.fileGeneration) return;
      this.error = errorCode(cause);
      this.treeUnavailable = true;
      this.treeFailedFor = sha;
    } finally {
      if (generation === this.fileGeneration) this.treeLoading = false;
    }
  }

  /** Read one file at the open commit. Clicking the open file again closes it. */
  async openFile(path: string): Promise<void> {
    const hostId = this.hostId;
    const repoId = this.repoId;
    const sha = this.selected;
    if (!hostId || !repoId || !sha) return;
    if (this.filePath === path) {
      this.filePath = null;
      this.fileBlob = null;
      this.fileUnavailable = false;
      return;
    }

    const generation = ++this.fileGeneration;
    this.filePath = path;
    this.fileBlob = null;
    this.fileUnavailable = false;

    const cached = this.files.getBlob(repoId, sha, path);
    if (cached) {
      this.fileBlob = cached;
      return;
    }

    this.fileLoading = true;
    try {
      const value = await this.pollFor(
        () => this.api.commitBlob(hostId, repoId, sha, path),
        generation,
      );
      if (generation !== this.fileGeneration) return;
      if (value) {
        this.files.putBlob(repoId, sha, path, value);
        this.fileBlob = value;
      } else {
        this.fileUnavailable = true;
      }
    } catch (cause: unknown) {
      if (generation !== this.fileGeneration) return;
      this.error = errorCode(cause);
      this.fileUnavailable = true;
    } finally {
      if (generation === this.fileGeneration) this.fileLoading = false;
    }
  }

  /**
   * Ask, and keep asking only while the server says an answer is on its way.
   *
   * The server answers a miss with `available: false, pending: 1` — meaning it has
   * asked the agent — and a flat `pending: 0` when nobody is going to bring it (the
   * host is offline, or the request hit a ceiling). Only the first is worth waiting
   * on, and only for a bounded number of tries: an agent too old to understand the
   * frame never answers at all, and a spinner that never ends is the failure mode
   * this budget exists to convert into a sentence on screen.
   */
  private async pollFor<T>(
    ask: () => Promise<DetailResponse<T>>,
    generation: number,
  ): Promise<T | null> {
    for (let attempt = 0; attempt < FILE_POLL_ATTEMPTS; attempt++) {
      const response = await ask();
      if (generation !== this.fileGeneration) return null;
      if (response.available && response.detail) return response.detail;
      if (response.pending === 0) return null;
      await this.wait(FILE_POLL_DELAY_MS);
      if (generation !== this.fileGeneration) return null;
    }
    return null;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.scheduleFn(() => resolve(), ms);
    });
  }

  private clearFileState(): void {
    this.fileGeneration += 1;
    this.treeFailedFor = null;
    this.tree = null;
    this.treeLoading = false;
    this.treeUnavailable = false;
    this.filePath = null;
    this.fileBlob = null;
    this.fileLoading = false;
    this.fileUnavailable = false;
  }

  /**
   * The panel is going off screen (unmount, navigation) but the dock's state outlives
   * it — the shell keeps one instance so returning to the dashboard finds the same
   * repository and the same open commit. Polling for a panel nobody can see is exactly
   * the leak to avoid, so the wait ends here and the user gets a retry to press.
   */
  suspend(): void {
    this.watch.suspend();
    // ⚠ THE CACHE GOES WITH THE PANEL. The dock's selection deliberately outlives
    // the view so returning finds the same commit — file CONTENTS must not, or a
    // tab left open for a day holds every file anybody opened in it. Coming back
    // costs one request per thing actually looked at again.
    this.files.dispose();
    this.clearFileState();
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
