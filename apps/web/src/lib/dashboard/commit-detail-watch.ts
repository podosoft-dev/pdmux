/**
 * The wait between "a click asked for a commit's patch" and "the patch is here".
 *
 * WHY THIS EXISTS AT ALL. Opening a commit whose detail is not stored makes the
 * server ask the host agent for it, and the answer lands through the ordinary ingest
 * path a second or two later — but the click had already been answered with
 * `available: false`. The panel therefore showed the patch only if the user clicked
 * the SAME row a second time, which reads as "clicking did nothing", then "clicking
 * again fixed it". That is worse than a visible wait, so this polls until it arrives.
 *
 * WHY IT IS PLAIN TYPESCRIPT AND NOT PART OF `GitDock`. The rules here — when to poll,
 * how long to wait, when to stop — are exactly what a unit test needs to pin down, and
 * `apps/web`'s vitest runs without the Svelte compiler, so a module that uses runes
 * cannot be imported by one. Same division as `terminal-relay.ts`: transport and
 * timing live in a testable class, and the runes file is the thin `$state` mapping.
 *
 * WHAT KEEPS IT FROM BECOMING A LEAK. Every poll carries the generation it started in;
 * selecting another commit, closing the panel, changing repository or unmounting bumps
 * that number, so an answer in flight for a commit nobody is looking at is dropped
 * rather than painted over the current one. A retry that outlives the thing it was
 * fetching for is a leak with a UI attached.
 */
import type { CommitDetail } from "@pdmux/protocol";
import { type PendingNote, pendingNote } from "@pdmux/core";
import { DETAIL_RETRY, type DetailRetryLimits, detailRetry } from "./commit-detail-retry";
import type { DetailResponse } from "./types";

/** The same note, reported as "we stopped waiting" rather than "still coming". */
const timedOutNote = (note: PendingNote): PendingNote => ({ ...note, kind: "timeout" });

/** Everything the panel renders about one commit's changes, in one value. */
export interface DetailWatchState {
  /** The commit being watched, or null when nothing is. */
  sha: string | null;
  detail: CommitDetail | null;
  /** Set when there is no detail: collecting / missing / timed out. */
  pending: PendingNote | null;
  /**
   * The FIRST fetch only. A poll deliberately leaves this false so the "still being
   * collected" note stays on screen instead of flickering back to "Loading changes…"
   * every few hundred milliseconds.
   */
  loading: boolean;
}

export const IDLE_DETAIL_STATE: DetailWatchState = {
  sha: null,
  detail: null,
  pending: null,
  loading: false,
};

export interface CommitDetailWatchOptions {
  /** Asks the API for one sha. Injected so a test needs no HTTP client. */
  fetch: (sha: string) => Promise<DetailResponse<CommitDetail>>;
  onChange: (state: DetailWatchState) => void;
  limits?: DetailRetryLimits;
  /** Exposed so a test does not wait real seconds. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export class CommitDetailWatch {
  private readonly fetchDetail: (sha: string) => Promise<DetailResponse<CommitDetail>>;
  private readonly onChange: (state: DetailWatchState) => void;
  private readonly limits: DetailRetryLimits;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  /** Bumped by anything that makes an in-flight answer irrelevant. */
  private generation = 0;
  private handle: unknown = null;
  private sha: string | null = null;
  /** The last count the server reported, so a failed poll keeps saying something true. */
  private lastPending = 0;

  constructor(options: CommitDetailWatchOptions) {
    this.fetchDetail = options.fetch;
    this.onChange = options.onChange;
    this.limits = options.limits ?? DETAIL_RETRY;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** True while a poll is scheduled — the page's "are we waiting" answer. */
  get waiting(): boolean {
    return this.handle !== null;
  }

  /** Open a commit: fetch once, then poll only if the server says one is coming. */
  start(sha: string): Promise<void> {
    const generation = this.reset();
    this.sha = sha;
    this.lastPending = 0;
    this.onChange({ sha, detail: null, pending: null, loading: true });
    return this.ask(sha, 0, generation);
  }

  /** The user pressed "try again" after we gave up. A fresh budget, not one more poll. */
  retry(): Promise<void> {
    const sha = this.sha;
    if (!sha) return Promise.resolve();
    return this.start(sha);
  }

  /** Selection changed, or the panel closed: stop polling and forget the commit. */
  stop(): void {
    this.reset();
    this.sha = null;
    this.lastPending = 0;
    this.onChange(IDLE_DETAIL_STATE);
  }

  /**
   * The panel went away while we were waiting (unmount, navigation).
   *
   * Polling for a panel nobody can see is the leak this whole class is careful about,
   * but silently clearing the state would leave a returning user with a commit header
   * and no explanation. So the wait ends the way the ceiling ends it: "did not arrive",
   * with a retry they can press.
   */
  suspend(): void {
    const sha = this.sha;
    const waiting = this.waiting;
    this.reset();
    if (!waiting || !sha) return;
    this.onChange({
      sha,
      detail: null,
      pending: timedOutNote(pendingNote({ pending: this.lastPending }, sha)),
      loading: false,
    });
  }

  /** Cancel whatever is scheduled and invalidate every answer still in flight. */
  private reset(): number {
    if (this.handle !== null) {
      this.cancel(this.handle);
      this.handle = null;
    }
    this.generation += 1;
    return this.generation;
  }

  private async ask(sha: string, attempt: number, generation: number): Promise<void> {
    let response: DetailResponse<CommitDetail>;
    try {
      response = await this.fetchDetail(sha);
    } catch {
      // A failed poll is not a failed feature — the collection may still be running.
      // Spend the attempt and keep the last count we were told, so the note stays true.
      response = { available: false, detail: null, pending: this.lastPending };
    }
    if (generation !== this.generation) return; // superseded — drop it on the floor
    this.apply(sha, response, attempt, generation);
  }

  private apply(
    sha: string,
    response: DetailResponse<CommitDetail>,
    attempt: number,
    generation: number,
  ): void {
    const step = detailRetry(response, attempt, this.limits);
    if (step.kind === "arrived") {
      this.onChange({ sha, detail: response.detail, pending: null, loading: false });
      return;
    }
    const note = pendingNote({ pending: response.pending }, sha);
    if (step.kind === "missing") {
      // `pending: 0` means nobody was asked. Polling would be a useless request every
      // few hundred milliseconds for as long as the panel stays open.
      this.onChange({ sha, detail: null, pending: note, loading: false });
      return;
    }
    this.lastPending = note.pending;
    if (step.kind === "exhausted") {
      this.onChange({ sha, detail: null, pending: timedOutNote(note), loading: false });
      return;
    }
    this.onChange({ sha, detail: null, pending: note, loading: false });
    this.handle = this.schedule(() => {
      this.handle = null;
      if (generation !== this.generation) return;
      void this.ask(sha, step.attempt, generation);
    }, step.delayMs);
  }
}
