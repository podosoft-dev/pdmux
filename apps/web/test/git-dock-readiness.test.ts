import { describe, expect, it } from "vitest";
import { GitDock } from "../src/lib/dashboard/git-dock.svelte";

/**
 * "Nothing here" and "nobody asked yet" are different answers, and the dock used to give
 * the first one for both. Between first paint and the repository response there is
 * nothing in `repos`, so the panel announced "No repositories collected on this host
 * yet" — a verdict on a question it had not put — for roughly 600ms after every refresh,
 * across a column several hundred pixels wide.
 */
const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (e: unknown) => void } => {
  let resolve!: (value: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("[TC-PDGIT-011] the dock knows the difference between empty and unasked", () => {
  it("is not 'loaded' until the repository list actually comes back", async () => {
    const gate = deferred<{ id: string; name: string }[]>();
    const dock = new GitDock({ api: { repos: () => gate.promise } as never });

    // Before anything: no claim can be made.
    expect(dock.reposLoaded).toBe(false);

    const open = dock.openHost("h1");
    // In flight — `repos` is empty here, and that is exactly the trap.
    expect(dock.repos).toEqual([]);
    expect(dock.reposLoaded).toBe(false);

    gate.resolve([]);
    await open;

    // Answered: the list really is empty, and now saying so is honest.
    expect(dock.reposLoaded).toBe(true);
    expect(dock.repos).toEqual([]);
  });

  it("counts a failure as answered, so the error speaks instead of a false emptiness", async () => {
    const dock = new GitDock({ api: { repos: () => Promise.reject(new Error("boom")) } as never });
    await dock.openHost("h1");

    expect(dock.reposLoaded).toBe(true);
    expect(dock.error).not.toBeNull();
  });

  it("goes back to 'unknown' when it is pointed at another host", async () => {
    // The queue lets the first host answer immediately and the second one hang, so the
    // assertion lands while the second request is genuinely in flight.
    const gates: Array<(rows: never[]) => void> = [];
    const dock = new GitDock({
      api: {
        repos: () =>
          new Promise<never[]>((resolve) => {
            gates.push(resolve);
          }),
      } as never,
    });

    const first = dock.openHost("h1");
    gates[0]?.([]);
    await first;
    expect(dock.reposLoaded).toBe(true);

    // A different host is a new question; the previous answer must not carry over.
    const second = dock.openHost("h2");
    expect(dock.reposLoaded).toBe(false);
    gates[1]?.([]);
    await second;
    expect(dock.reposLoaded).toBe(true);
  });
});
