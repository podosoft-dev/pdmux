/**
 * The wait between clicking a commit and its patch appearing.
 *
 * THE DEFECT THIS LOCKS DOWN: opening a commit whose detail is not stored makes the
 * server ask the host agent for it, and the answer arrives a second or two later
 * through ingest — but the panel fetched once and stopped, so the patch showed up only
 * if the user clicked the same row AGAIN. "Clicking did nothing", then "clicking again
 * fixed it".
 *
 * The two answers that look identical on screen are opposites underneath, so both are
 * pinned here: `pending > 0` means an agent was asked and polling ends in success;
 * `pending: 0` means nobody was asked and polling is a guaranteed-useless request every
 * few hundred milliseconds. And every stop condition is a test of its own, because a
 * retry that outlives the panel it was fetching for is a leak with a UI attached.
 */
import { describe, expect, it, vi } from "vitest";
import type { CommitDetail } from "@pdmux/protocol";
import { DETAIL_RETRY, detailRetry, detailRetryCeilingMs } from "$lib/dashboard/commit-detail-retry";
import { CommitDetailWatch, type DetailWatchState } from "$lib/dashboard/commit-detail-watch";
import type { DetailResponse } from "$lib/dashboard/types";

type Fetch = (sha: string) => Promise<DetailResponse<CommitDetail>>;

/** A commit detail, minimal but shaped like the real one. */
function patch(sha: string): CommitDetail {
  return {
    sha,
    subject: "fix a thing",
    body: "why",
    bodyTruncated: false,
    files: [
      { path: "a.ts", oldPath: null, status: "M", add: 1, del: 0, binary: false, truncated: false, lines: ["+x"] },
    ],
    dropped: 0,
    truncated: false,
    empty: false,
  };
}

const miss = (pending: number): DetailResponse<CommitDetail> => ({ available: false, detail: null, pending });
const hit = (sha: string): DetailResponse<CommitDetail> => ({ available: true, detail: patch(sha), pending: 0 });

/**
 * A hand-cranked clock. Timers are values in a list, so a test can assert the exact
 * delays that were asked for and fire them one at a time — no real waiting, and no
 * ambiguity about which callback ran.
 */
function clock(): {
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  delays: number[];
  live: () => number;
  tick: () => Promise<void>;
} {
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  let next = 1;
  return {
    schedule: (fn, ms) => {
      delays.push(ms);
      const id = next++;
      timers.set(id, fn);
      return id;
    },
    cancel: (handle) => void timers.delete(handle as number),
    delays,
    live: () => timers.size,
    tick: async () => {
      const [id, fn] = [...timers.entries()][0] ?? [];
      if (id === undefined || !fn) return;
      timers.delete(id);
      fn();
      // Let the fetch and its `.then` chain run before the assertions.
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function watcher(fetch: Fetch) {
  const time = clock();
  const states: DetailWatchState[] = [];
  const watch = new CommitDetailWatch({
    fetch,
    onChange: (state) => void states.push(state),
    schedule: time.schedule,
    cancel: time.cancel,
  });
  return { watch, states, time, last: () => states[states.length - 1]! };
}

describe("[TC-PDUI-164] a patch that is still being collected arrives without a second click", () => {
  it("backs off on each poll and stops at the ceiling", () => {
    // 500ms, 1s, 2s, then 4s capped — the click itself is what asks the agent, so the
    // early polls are tight and the tail is cheap.
    const delays: number[] = [];
    let attempt = 0;
    for (;;) {
      const step = detailRetry(miss(3), attempt);
      if (step.kind !== "retry") {
        expect(step.kind).toBe("exhausted");
        break;
      }
      delays.push(step.delayMs);
      attempt = step.attempt;
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 4000, 4000, 4000]);
    expect(delays).toHaveLength(DETAIL_RETRY.attempts);
    expect(delays.reduce((sum, ms) => sum + ms, 0)).toBe(detailRetryCeilingMs());
    expect(detailRetryCeilingMs()).toBe(19_500);
  });

  it("never polls when nothing is coming, and stops the moment it lands", () => {
    // `pending: 0` = nobody was asked (host offline, or the agent answered without
    // this sha). Polling that is a useless request for as long as the panel is open.
    expect(detailRetry(miss(0), 0)).toEqual({ kind: "missing" });
    expect(detailRetry(miss(0), 5)).toEqual({ kind: "missing" });
    expect(detailRetry(hit("abc"), 0)).toEqual({ kind: "arrived" });
    // Junk is treated as "nothing is coming" — the answer that costs nothing.
    expect(detailRetry(null, 0)).toEqual({ kind: "missing" });
    expect(detailRetry({ pending: "soon" }, 0)).toEqual({ kind: "missing" });
    expect(detailRetry(miss(1), -3)).toMatchObject({ kind: "retry", delayMs: 500, attempt: 1 });
  });

  it("shows the wait, then the patch, with no further timers", async () => {
    const fetch = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(miss(2))
      .mockResolvedValueOnce(miss(1))
      .mockResolvedValueOnce(hit("f00"));
    const { watch, states, time, last } = watcher(fetch);

    await watch.start("f00");
    // The first fetch says "loading", then the miss becomes a VISIBLE wait rather
    // than an empty panel.
    expect(states[0]).toMatchObject({ sha: "f00", loading: true, detail: null });
    expect(last()).toMatchObject({ loading: false, pending: { kind: "collecting", pending: 2 } });
    expect(watch.waiting).toBe(true);

    await time.tick();
    expect(last()).toMatchObject({ pending: { kind: "collecting", pending: 1 } });

    await time.tick();
    expect(last()).toMatchObject({ sha: "f00", pending: null, loading: false });
    expect(last().detail?.sha).toBe("f00");
    // The point of the whole exercise: no second click, and nothing left running.
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(watch.waiting).toBe(false);
    expect(time.live()).toBe(0);
    expect(time.delays).toEqual([500, 1000]);
  });

  it("says so and does not poll when the server says nothing is coming", async () => {
    const fetch = vi.fn<Fetch>().mockResolvedValue(miss(0));
    const { watch, time, last } = watcher(fetch);

    await watch.start("dead");
    expect(last()).toMatchObject({ pending: { kind: "missing", pending: 0, shortSha: "dead" } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(time.live()).toBe(0);
    expect(time.delays).toEqual([]);
    expect(watch.waiting).toBe(false);
  });

  it("gives up at the ceiling and offers a retry that starts a fresh budget", async () => {
    const fetch = vi.fn<Fetch>().mockResolvedValue(miss(4));
    const { watch, time, last } = watcher(fetch);

    await watch.start("slow");
    for (let i = 0; i < DETAIL_RETRY.attempts; i++) await time.tick();

    // A spinner forever is not an answer: the panel must say it did not arrive.
    expect(last()).toMatchObject({ sha: "slow", detail: null, pending: { kind: "timeout" }, loading: false });
    expect(fetch).toHaveBeenCalledTimes(DETAIL_RETRY.attempts + 1);
    expect(time.live()).toBe(0);
    expect(time.delays).toEqual([500, 1000, 2000, 4000, 4000, 4000, 4000]);

    fetch.mockResolvedValue(hit("slow"));
    await watch.retry();
    expect(last().detail?.sha).toBe("slow");
  });

  it("stops when the user selects another commit, and drops the answer in flight", async () => {
    const held: Array<(response: DetailResponse<CommitDetail>) => void> = [];
    const fetch = vi.fn<Fetch>((sha) => {
      if (sha === "old") return new Promise<DetailResponse<CommitDetail>>((resolve) => held.push(resolve));
      return Promise.resolve(miss(0));
    });
    const { watch, states, time } = watcher(fetch);

    const first = watch.start("old");
    await watch.start("new");
    expect(time.live()).toBe(0);

    // The abandoned request answers late — and with a patch, which is the worst case:
    // painting it would put the previous commit's diff under the new commit's header.
    held[0]?.(hit("old"));
    await first;
    expect(states.some((state) => state.detail !== null)).toBe(false);
    expect(states.filter((state) => state.sha === "old" && state.loading)).toHaveLength(1);
  });

  it("stops when the panel closes and when it unmounts mid-wait", async () => {
    const fetch = vi.fn<Fetch>().mockResolvedValue(miss(2));
    const { watch, time, last } = watcher(fetch);

    await watch.start("open");
    expect(time.live()).toBe(1);
    watch.stop(); // the row was clicked again — the panel is closed
    expect(time.live()).toBe(0);
    expect(last()).toMatchObject({ sha: null, detail: null, pending: null, loading: false });

    await watch.start("open");
    expect(time.live()).toBe(1);
    watch.suspend(); // the dock unmounted — navigation, not a decision about this commit
    expect(time.live()).toBe(0);
    // Clearing would leave a returning user with a header and no explanation, so the
    // wait ends the way the ceiling ends it: with something they can press.
    expect(last()).toMatchObject({ sha: "open", pending: { kind: "timeout", pending: 2 } });

    // Whatever was scheduled before must never fire against the API afterwards.
    const calls = fetch.mock.calls.length;
    await time.tick();
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it("spends an attempt on a failed poll instead of calling the feature broken", async () => {
    const fetch = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(miss(3))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(hit("flaky"));
    const { watch, time, last } = watcher(fetch);

    await watch.start("flaky");
    await time.tick(); // the poll that fails
    // The count last reported by the server survives, so the note stays true.
    expect(last()).toMatchObject({ pending: { kind: "collecting", pending: 3 } });
    await time.tick();
    expect(last().detail?.sha).toBe("flaky");
  });
});
