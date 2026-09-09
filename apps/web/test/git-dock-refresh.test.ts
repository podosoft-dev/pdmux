import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from "vitest";
import { ApiError } from "@podosoft/podokit-api-client";
import { UNCOMMITTED } from "@pdmux/core";
import { commitDetailSchema, gitBlobSchema, gitTreeSchema, workingDiffSchema } from "@pdmux/protocol";
import { GitDock } from "../src/lib/dashboard/git-dock.svelte";
import { gitApi } from "../src/lib/dashboard/api";
import type { RepoGraphResponse, RepoRow } from "../src/lib/dashboard/types";
import { graphSnapshot, repository, NEW_SHA, OLD_SHA } from "./fixtures/git-snapshot";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve: (value) => resolve(value) };
}

function fixture(): {
  dock: GitDock;
  api: ReturnType<typeof apiFixture>;
  update: (patch: Partial<RepoRow>) => void;
} {
  let graph = graphSnapshot();
  const api = apiFixture(() => graph);
  const dock = new GitDock({ api });
  return { dock, api, update: (patch) => { graph = graphSnapshot(repository(patch)); } };
}

function apiFixture(graph: () => RepoGraphResponse): Mocked<typeof gitApi> {
  return {
    repos: vi.fn<typeof gitApi.repos>(async () => [graph().repo]),
    graph: vi.fn<typeof gitApi.graph>(async () => graph()),
    collect: vi.fn<typeof gitApi.collect>(async (hostId, what) => ({ hostId, what })),
    commitDetail: vi.fn<typeof gitApi.commitDetail>(async () => ({ available: true, pending: 0, detail: commitDetailSchema.parse({ sha: OLD_SHA }) })),
    commitTree: vi.fn<typeof gitApi.commitTree>(async () => ({ available: true, pending: 0, detail: gitTreeSchema.parse({ sha: OLD_SHA }) })),
    commitBlob: vi.fn<typeof gitApi.commitBlob>(async () => ({ available: true, pending: 0,
      detail: gitBlobSchema.parse({ sha: OLD_SHA, path: "a.ts", lines: ["const x = 1;"] }) })),
    workingDiff: vi.fn<typeof gitApi.workingDiff>(async () => ({ available: true, pending: 0, detail: workingDiffSchema.parse({}) })),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("[TC-PDGIT-050] refresh reads snapshots without reopening the selection", () => {
  it("keeps the commit, tree and file while rows, refs and freshness change", async () => {
    const { dock, api, update } = fixture();
    await dock.openHost("h1");
    await dock.select(OLD_SHA);
    await dock.ensureTree();
    await dock.openFile("a.ts");
    const detail = dock.detail;
    const tree = dock.tree;
    const file = dock.fileBlob;
    update({ headSha: NEW_SHA, dirtyCount: 2, lastSnapshotAt: "2026-09-07T01:00:00.000Z" });
    await dock.refresh();
    expect(dock.graph?.commits[0]?.sha).toBe(NEW_SHA);
    expect(dock.graph?.refs[0]?.sha).toBe(NEW_SHA);
    expect(dock.repo?.dirtyCount).toBe(2);
    expect(dock.repo?.lastSnapshotAt).toBe("2026-09-07T01:00:00.000Z");
    expect(dock.selected).toBe(OLD_SHA);
    expect(dock.detail).toBe(detail);
    expect(dock.tree).toBe(tree);
    expect(dock.fileBlob).toBe(file);
    expect(dock.filePath).toBe("a.ts");
    expect(api.commitDetail).toHaveBeenCalledTimes(1);
    expect(api.commitTree).toHaveBeenCalledTimes(1);
    expect(api.commitBlob).toHaveBeenCalledTimes(1);
  });

  it("polls automatically without requiring a timestamp change or another POST", async () => {
    const { dock, api, update } = fixture();
    await dock.openHost("h1");
    dock.resume();
    await dock.refresh();
    update({ headSha: NEW_SHA });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dock.graph?.commits[0]?.sha).toBe(NEW_SHA);
    expect(api.collect).not.toHaveBeenCalled();
  });

  it("waits beyond two seconds and refreshes after a manual request was accepted", async () => {
    const { dock, api, update } = fixture();
    await dock.openHost("h1");
    dock.resume();
    await dock.collect("repos");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(dock.collecting).toBe("repos");
    update({ headSha: NEW_SHA });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dock.collecting).toBeNull();
    expect(dock.graph?.commits[0]?.sha).toBe(NEW_SHA);
    expect(api.collect).toHaveBeenCalledTimes(1);
  });

  it("takes a fresh baseline before POST instead of comparing to a stale screen", async () => {
    const { dock, update } = fixture();
    await dock.openHost("h1");
    dock.resume();
    await dock.refresh();
    update({ headSha: NEW_SHA });
    await dock.collect("repos");
    expect(dock.graph?.commits[0]?.sha).toBe(NEW_SHA);
    expect(dock.collecting).toBe("repos");
  });

  it("does not finish a remote check when only the local snapshot changed", async () => {
    const { dock, update } = fixture();
    await dock.openHost("h1");
    dock.resume();
    await dock.collect("remote");
    update({ headSha: NEW_SHA, lastSnapshotAt: "2026-09-07T01:00:00.000Z" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dock.collecting).toBe("remote");
    update({ remoteCheckedAt: "2026-09-07T01:00:00.000Z", remoteError: "unreachable" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dock.collecting).toBeNull();
    expect(dock.repo?.remoteError).toBe("unreachable");
  });

  it("recognizes changed remote refs within the same timestamp second", async () => {
    const { dock, update } = fixture();
    const remoteCheckedAt = "2026-09-07T01:00:00.000Z";
    update({ remoteCheckedAt, remoteRefs: [] });
    await dock.openHost("h1");
    dock.resume();
    await dock.collect("remote");
    update({ remoteCheckedAt, remoteRefs: [{ kind: "branch", name: "main", sha: NEW_SHA }] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dock.collecting).toBeNull();
    expect(dock.repo?.remoteRefs?.[0]?.sha).toBe(NEW_SHA);
  });

  it("updates the mutable working diff, including a now-clean tree", async () => {
    const { dock, api, update } = fixture();
    update({ dirtyCount: 1, hasWorkingDiff: true });
    await dock.openHost("h1");
    await dock.select(UNCOMMITTED);
    const detail = workingDiffSchema.parse({ unstaged: [{ path: "b.ts", status: "M", lines: ["+new"] }] });
    api.workingDiff.mockResolvedValue({ available: true, pending: 0, detail });
    await dock.refresh();
    expect(dock.working?.unstaged[0]?.path).toBe("b.ts");
    update({ dirtyCount: 0, hasWorkingDiff: false });
    api.workingDiff.mockResolvedValue({ available: false, pending: 0, detail: null });
    await dock.refresh();
    expect(dock.working).toBeNull();
    expect(dock.selected).toBe(UNCOMMITTED);
  });

  it("clears a commit only when it leaves the graph window", async () => {
    const { dock, api } = fixture();
    await dock.openHost("h1");
    await dock.select(OLD_SHA);
    api.graph.mockResolvedValue({ ...graphSnapshot(), commits: [] });
    await dock.refresh();
    expect(dock.selected).toBeNull();
    expect(dock.detail).toBeNull();
  });

  it("discovers the first repo after an empty scan and does not invent a replacement after deletion", async () => {
    const { dock, api } = fixture();
    api.repos.mockResolvedValueOnce([]);
    await dock.openHost("h1");
    expect(dock.repoId).toBeNull();
    await dock.refresh();
    expect(dock.repoId).toBe(repository().id);
    api.repos.mockResolvedValue([repository({ id: "other" })]);
    await dock.refresh();
    await dock.refresh();
    expect(dock.repoId).toBeNull();
    expect(dock.graph).toBeNull();
    expect(dock.error).toBe("GIT_REPO_NOT_FOUND");
  });
});

describe("[TC-PDGIT-051] refresh is bounded and belongs to the visible target", () => {
  it("does not supersede a new working-tree selection with an obsolete refresh", async () => {
    const { dock, api } = fixture();
    await dock.openHost("h1");
    await dock.select(UNCOMMITTED);
    const graph = deferred<RepoGraphResponse>();
    api.graph.mockReturnValueOnce(graph.promise);
    const refresh = dock.refresh();
    await vi.advanceTimersByTimeAsync(0);
    await dock.select(UNCOMMITTED);
    const working = deferred<Awaited<ReturnType<typeof gitApi.workingDiff>>>();
    api.workingDiff.mockReturnValueOnce(working.promise);
    const click = dock.select(UNCOMMITTED);
    graph.resolve(graphSnapshot());
    await refresh;
    const detail = workingDiffSchema.parse({ unstaged: [{ path: "selected.ts", status: "M" }] });
    working.resolve({ available: true, pending: 0, detail });
    await click;
    expect(dock.working?.unstaged[0]?.path).toBe("selected.ts");
  });

  it("ignores a collection POST that finishes after a host change", async () => {
    const { dock, api } = fixture();
    await dock.openHost("h1");
    dock.resume();
    const gate = deferred<Awaited<ReturnType<typeof gitApi.collect>>>();
    api.collect.mockReturnValueOnce(gate.promise);
    const collection = dock.collect("repos");
    await vi.advanceTimersByTimeAsync(0);
    expect(api.collect).toHaveBeenCalledTimes(1);
    api.repos.mockResolvedValue([]);
    await dock.openHost("h2");
    gate.resolve({ hostId: "h1", what: "repos" });
    await collection;
    expect(dock.hostId).toBe("h2");
    expect(dock.graph).toBeNull();
    expect(dock.collecting).toBeNull();
    expect(dock.collectionError).toBeNull();
  });

  it("does not overwrite a refreshed working diff with the older click response", async () => {
    const { dock, api } = fixture();
    await dock.openHost("h1");
    const gate = deferred<Awaited<ReturnType<typeof gitApi.workingDiff>>>();
    api.workingDiff.mockReturnValueOnce(gate.promise);
    const click = dock.select(UNCOMMITTED);
    const fresh = workingDiffSchema.parse({ unstaged: [{ path: "fresh.ts", status: "M" }] });
    api.workingDiff.mockResolvedValue({ available: true, pending: 0, detail: fresh });
    await dock.refresh();
    gate.resolve({ available: true, pending: 0, detail: workingDiffSchema.parse({}) });
    await click;
    expect(dock.working?.unstaged[0]?.path).toBe("fresh.ts");
  });

  it("coalesces reads and ignores a late response after changing hosts", async () => {
    const { dock, api } = fixture();
    await dock.openHost("h1");
    const gate = deferred<RepoRow[]>();
    api.repos.mockReturnValueOnce(gate.promise);
    const first = dock.refresh();
    expect(dock.refresh()).toBe(first);
    api.repos.mockResolvedValue([]);
    const second = dock.openHost("h2");
    gate.resolve([repository()]);
    await Promise.all([first, second]);
    expect(dock.hostId).toBe("h2");
    expect(dock.repos).toEqual([]);
    expect(dock.graph).toBeNull();
  });

  it("ignores an old graph after selecting another repository", async () => {
    const { dock, api } = fixture();
    const other = repository({ id: "other" });
    api.repos.mockResolvedValue([repository(), other]);
    await dock.openHost("h1");
    const gate = deferred<RepoGraphResponse>();
    api.graph.mockReturnValueOnce(gate.promise).mockResolvedValue(graphSnapshot(other));
    const first = dock.refresh();
    await vi.advanceTimersByTimeAsync(0);
    const second = dock.openRepo("other");
    gate.resolve(graphSnapshot());
    await Promise.all([first, second]);
    expect(dock.repoId).toBe("other");
    expect(dock.graph?.repo.id).toBe("other");
  });

  it("pauses without dropping the file and resumes immediately", async () => {
    const { dock, api, update } = fixture();
    await dock.openHost("h1");
    await dock.select(OLD_SHA);
    await dock.openFile("a.ts");
    dock.resume();
    await dock.refresh();
    dock.pause();
    const calls = api.graph.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.graph).toHaveBeenCalledTimes(calls);
    expect(dock.filePath).toBe("a.ts");
    update({ headSha: NEW_SHA });
    dock.resume();
    await dock.refresh();
    expect(dock.graph?.commits[0]?.sha).toBe(NEW_SHA);
    expect(dock.filePath).toBe("a.ts");
    dock.suspend();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops a response after suspension without scheduling another request", async () => {
    const { dock, api } = fixture();
    await dock.openHost("h1");
    const gate = deferred<RepoRow[]>();
    api.repos.mockReturnValueOnce(gate.promise);
    dock.resume();
    const pending = dock.refresh();
    dock.suspend();
    gate.resolve([]);
    await pending;
    expect(dock.repos).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not send duplicate collection requests", async () => {
    const { dock, api } = fixture();
    await dock.openHost("h1");
    dock.resume();
    await Promise.all([dock.collect("repos"), dock.collect("remote")]);
    expect(api.collect).toHaveBeenCalledTimes(1);
    expect(dock.collecting).toBe("repos");
  });

  it.each(["HOST_OFFLINE", "FORBIDDEN"])("reports %s and leaves the last graph intact", async (code) => {
    const { dock, api } = fixture();
    await dock.openHost("h1");
    const baselineTimers = vi.getTimerCount();
    api.collect.mockRejectedValue(new ApiError(code, "not available", 409));
    await dock.collect("repos");
    expect(dock.collectionError).toBe(code);
    expect(dock.collecting).toBeNull();
    expect(dock.graph?.commits[0]?.sha).toBe(OLD_SHA);
    expect(vi.getTimerCount()).toBe(baselineTimers);
  });

  it("keeps the graph on a failed refresh and recovers on the next poll", async () => {
    const { dock, api, update } = fixture();
    await dock.openHost("h1");
    dock.resume();
    await dock.refresh();
    api.repos.mockRejectedValueOnce(new Error("network"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dock.refreshError).toBe("NETWORK_ERROR");
    expect(dock.graph?.commits[0]?.sha).toBe(OLD_SHA);
    update({ headSha: NEW_SHA });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dock.refreshError).toBeNull();
    expect(dock.graph?.commits[0]?.sha).toBe(NEW_SHA);
  });

  it("ends the wait at sixty seconds, keeps automatic reads, and allows retry", async () => {
    const { dock, update } = fixture();
    await dock.openHost("h1");
    const baselineTimers = vi.getTimerCount();
    dock.resume();
    await dock.collect("repos");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dock.collecting).toBeNull();
    expect(dock.collectionError).toBe("GIT_REFRESH_TIMEOUT");
    expect(vi.getTimerCount()).toBe(baselineTimers + 1);
    update({ headSha: NEW_SHA });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dock.graph?.commits[0]?.sha).toBe(NEW_SHA);
    await dock.collect("repos");
    expect(dock.collectionError).toBeNull();
    expect(dock.collecting).toBe("repos");
  });

  it("bounds a stalled baseline and never sends a timed-out or cancelled request later", async () => {
    const { dock, api } = fixture();
    await dock.openHost("h1");
    const gate = deferred<RepoRow[]>();
    api.repos.mockReturnValueOnce(gate.promise);
    const pending = dock.collect("repos");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dock.collecting).toBeNull();
    gate.resolve([repository()]);
    await pending;
    expect(api.collect).not.toHaveBeenCalled();
    expect(dock.collectionError).toBe("GIT_REFRESH_TIMEOUT");
  });

  it("bounds each snapshot HTTP call without bypassing the same-origin client", async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("[]"));
    await gitApi.repos("h1");
    await gitApi.graph("h1", "r1");
    await gitApi.workingDiff("h1", "r1");
    await gitApi.collect("h1", "repos");
    expect(timeout.mock.calls).toEqual([[15_000], [15_000], [15_000], [15_000]]);
    expect(fetch).toHaveBeenCalledWith("/api/hosts/h1/repos", expect.objectContaining({ signal, credentials: "include" }));
  });
});
