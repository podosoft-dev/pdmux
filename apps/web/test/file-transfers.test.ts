import { describe, expect, it, vi } from "vitest";
import type { FileTransferEntryView, FileTransferView } from "@pdmux/protocol";
import { ApiError } from "@podosoft/podokit-api-client";
import { FileTransferController, TRANSFER_RETRY_LIMIT, transferRetryDelay } from "../src/lib/dashboard/file-transfers/controller.svelte";
import { FilesDock } from "../src/lib/dashboard/files-dock.svelte";
import { transferApi } from "../src/lib/dashboard/file-transfers/api";
import { chunkDigest, fingerprintSource, sourceFromDirectory, sourceFromDroppedEntries, sourceFromFiles, type DroppedEntry } from "../src/lib/dashboard/file-transfers/source";

describe("[TC-PDFILE-007] folder sources and acknowledged progress", (): void => {
  it("selects a directory without trying to preview it as a text file", (): void => {
    const read = vi.fn();
    const dock = new FilesDock({ api: { read } });
    dock.hostId = "host";
    dock.dir = { path: "", home: "/home/example", entries: [{ name: "folder.txt", dir: true, symlink: false, size: 0, mode: 0o700, modified: 0 }], dropped: 0, truncated: false, error: null };
    dock.select("folder.txt", "toggle");
    expect(dock.selected).toEqual(["folder.txt"]);
    expect(read).not.toHaveBeenCalled();
    dock.transfers.dispose();
  });
  it("keeps empty directories and hashes files in bounded chunks", async (): Promise<void> => {
    const file = new File(["payload"], "file.txt", { lastModified: 1 });
    const source = await sourceFromDirectory({
      kind: "directory", name: "folder",
      async *values() {
        yield { kind: "directory" as const, name: "empty", async *values() {} };
        yield { kind: "file" as const, name: file.name, getFile: (): Promise<File> => Promise.resolve(file) };
      },
    });
    expect(source.entries.map((entry) => entry.path)).toEqual(["folder", "folder/empty", "folder/file.txt"]);
    await fingerprintSource(source, (): void => {});
    const digest = await chunkDigest(new TextEncoder().encode("payload"));
    expect(source.entries[2]?.fingerprint).toBe(await chunkDigest(new TextEncoder().encode(digest)));
    expect(await source.read("folder/file.txt", 2, 3)).toEqual(new TextEncoder().encode("ylo"));
  });
  it("reads every dropped directory batch, including the empty terminator", async (): Promise<void> => {
    let calls = 0;
    const empty = (name: string): DroppedEntry => ({
      name, isFile: false, isDirectory: true, file: (): void => { throw new Error("not a file"); },
      createReader: () => ({ readEntries: (success): void => success([]) }),
    });
    const root = empty("root");
    root.createReader = () => ({
      readEntries(success): void {
        calls++;
        success(calls <= 11 ? Array.from({ length: 100 }, (_, i) => empty(String(calls * 100 + i))) : []);
      },
    });
    const source = await sourceFromDroppedEntries([root]);
    expect(calls).toBe(12);
    expect(source.entries).toHaveLength(1101);
    expect(source.entries.every((entry) => entry.kind === "directory")).toBe(true);
  });
  it("detects a modified reselected file before reading its new bytes", async (): Promise<void> => {
    let file = new File(["original"], "file", { lastModified: 1 });
    const source = await sourceFromDirectory({
      kind: "directory", name: "root",
      async *values() { yield { kind: "file" as const, name: "file", getFile: (): Promise<File> => Promise.resolve(file) }; },
    });
    file = new File(["modified"], "file", { lastModified: 2 });
    await expect(source.read("root/file", 0, 8)).rejects.toThrow("FILES_TRANSFER_SOURCE_CHANGED");
  });
  it("waits for acknowledgements and resumes after a lost response without sending an empty tail", async (): Promise<void> => {
    let job: FileTransferView = {
      id: crypto.randomUUID(), hostId: "host", basePath: "captured", direction: "upload", state: "draft",
      bytes: 0, totalBytes: 0, completedEntries: 0, totalEntries: 0, currentPath: "", errorCode: "",
      exclusions: [], archiveBytes: 0, updated: 0, created: 0,
    };
    const entries: FileTransferEntryView[] = [];
    const calls: number[] = [];
    let release: (() => void) | undefined;
    const ack = new Promise<void>((resolve): void => { release = resolve; });
    let lost = true;
    const api: typeof transferApi = {
      ...transferApi,
      create: async (hostId, input) => { job = { ...job, ...input, hostId }; return { ...job }; },
      list: async () => [{ ...job }],
      get: async () => ({ ...job }),
      manifest: async (_hostId, _id, items) => {
        entries.push(...items.map((item) => ({ ...item, offset: 0, state: "pending" as const, replace: false })));
        job = { ...job, totalEntries: entries.length, totalBytes: items.reduce((sum, item) => sum + item.size, 0) };
        return { ...job };
      },
      control: async (_hostId, _id, action) => {
        job = { ...job, state: action === "start" ? "running" : "paused" };
        return { ...job };
      },
      entries: async () => structuredClone(entries),
      reconcile: async () => ({ ...entries[0]! }),
      chunk: async (_hostId, _id, _entryId, offset, _digest, data) => {
        calls.push(data.length);
        await ack;
        const entry = entries[0]!;
        entry.offset = offset + data.length;
        if (lost) { lost = false; throw new Error("FILES_TRANSFER_TIMEOUT"); }
        return { ...entry };
      },
      commit: async () => {
        entries[0]!.state = "committed";
        job = { ...job, state: "completed", bytes: entries[0]!.size, completedEntries: 1 };
        return { ...entries[0]! };
      },
    };
    const controller = new FileTransferController(api);
    try {
      await controller.prepare("host", "captured", () => sourceFromFiles([new File(["payload"], "file.txt")]));
      await vi.waitFor(() => expect(calls).toEqual([7]));
      expect(controller.jobs[0]?.bytes).toBe(0);
      expect(controller.jobs[0]?.basePath).toBe("captured");
      release?.();
      await vi.waitFor(() => expect(controller.jobs[0]?.state).toBe("paused"));
      await controller.resume(controller.jobs[0]!);
      await vi.waitFor(() => expect(controller.jobs[0]?.state).toBe("completed"));
      expect(calls).toEqual([7]);
      expect(controller.jobs[0]?.bytes).toBe(7);
    } finally { controller.dispose(); }
  });
});

/** A one-file upload against an in-memory API whose chunk answers come from `refuse` first. */
function refusingApi(refuse: (attempt: number) => Error | undefined): {
  api: typeof transferApi;
  calls: { chunk: number; reconcile: number; control: string[] };
} {
  let job: FileTransferView = {
    id: crypto.randomUUID(), hostId: "host", basePath: "captured", direction: "upload", state: "draft",
    bytes: 0, totalBytes: 0, completedEntries: 0, totalEntries: 0, currentPath: "", errorCode: "",
    exclusions: [], archiveBytes: 0, updated: 0, created: 0,
  };
  const entries: FileTransferEntryView[] = [];
  const calls = { chunk: 0, reconcile: 0, control: [] as string[] };
  const api: typeof transferApi = {
    ...transferApi,
    create: async (hostId, input) => { job = { ...job, ...input, hostId }; return { ...job }; },
    list: async () => [{ ...job }],
    get: async () => ({ ...job }),
    manifest: async (_hostId, _id, items) => {
      entries.push(...items.map((item) => ({ ...item, offset: 0, state: "pending" as const, replace: false })));
      job = { ...job, totalEntries: entries.length, totalBytes: items.reduce((sum, item) => sum + item.size, 0) };
      return { ...job };
    },
    control: async (_hostId, _id, action) => {
      calls.control.push(action);
      job = { ...job, state: action === "start" ? "running" : "paused" };
      return { ...job };
    },
    entries: async () => structuredClone(entries),
    reconcile: async () => { calls.reconcile++; return { ...entries[0]! }; },
    chunk: async (_hostId, _id, _entryId, offset, _digest, data) => {
      const refusal = refuse(calls.chunk++);
      if (refusal) throw refusal;
      entries[0]!.offset = offset + data.length;
      job = { ...job, bytes: entries[0]!.offset };
      return { ...entries[0]! };
    },
    commit: async () => {
      entries[0]!.state = "committed";
      job = { ...job, state: "completed", completedEntries: 1 };
      return { ...entries[0]! };
    },
  };
  return { api, calls };
}

const rateLimited = (retryAfterSeconds?: number): ApiError =>
  new ApiError("RATE_LIMIT_EXCEEDED", "Too many requests.", 429, undefined, retryAfterSeconds);
const unavailable = (): ApiError => new ApiError("BACKEND_UNAVAILABLE", "Service unavailable", 503);

describe("[TC-PDFILE-014] uploads wait out 429 and 503 instead of pausing", (): void => {
  it("waits for Retry-After or a doubling backoff, and only for refusals", (): void => {
    expect(transferRetryDelay(rateLimited(3), 0)).toBe(3_000);
    expect(transferRetryDelay(rateLimited(3), 2)).toBe(4_000);
    expect(transferRetryDelay(rateLimited(600), 0)).toBe(60_000);
    expect([0, 1, 2, 3, 4, 5].map((failures) => transferRetryDelay(unavailable(), failures)))
      .toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000]);
    expect(transferRetryDelay(unavailable(), TRANSFER_RETRY_LIMIT)).toBeNull();
    expect(transferRetryDelay(new ApiError("FILES_TRANSFER_CONFLICT", "Conflict", 409), 0)).toBeNull();
    expect(transferRetryDelay(new ApiError("BACKEND_TIMEOUT", "Timeout", 504), 0)).toBeNull();
    expect(transferRetryDelay(new Error("FILES_TRANSFER_TIMEOUT"), 0)).toBeNull();
  });

  it("retries a rate-limited chunk after Retry-After from the agent's offset and completes", async (): Promise<void> => {
    const { api, calls } = refusingApi((attempt) => attempt === 0 ? rateLimited(1) : undefined);
    const controller = new FileTransferController(api);
    try {
      const started = Date.now();
      await controller.prepare("host", "captured", () => sourceFromFiles([new File(["payload"], "file.txt")]));
      await vi.waitFor(() => expect(controller.jobs[0]?.state).toBe("completed"), { timeout: 5_000 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
      expect(calls).toEqual({ chunk: 2, reconcile: 2, control: ["start"] });
      expect(controller.error).toBe("");
    } finally { controller.dispose(); }
  });

  it("pauses with the error once the retries run out", async (): Promise<void> => {
    vi.useFakeTimers();
    const { api, calls } = refusingApi(() => unavailable());
    const controller = new FileTransferController(api);
    try {
      await controller.prepare("host", "captured", () => sourceFromFiles([new File(["payload"], "file.txt")]));
      await vi.waitFor(() => expect(calls.chunk).toBe(1));
      for (let waited = 0; waited < 70_000 && controller.jobs[0]?.state !== "paused"; waited += 1_000) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(controller.jobs[0]?.state).toBe("paused");
      expect(calls.chunk).toBe(TRANSFER_RETRY_LIMIT + 1);
      expect(calls.control).toEqual(["start", "pause"]);
      expect(controller.error).toBe("BACKEND_UNAVAILABLE");
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it("stops waiting when the user pauses, so resuming starts again at once", async (): Promise<void> => {
    const { api, calls } = refusingApi((attempt) => attempt === 0 ? rateLimited(30) : undefined);
    const controller = new FileTransferController(api);
    try {
      await controller.prepare("host", "captured", () => sourceFromFiles([new File(["payload"], "file.txt")]));
      await vi.waitFor(() => expect(calls.chunk).toBe(1));
      const pausedAt = Date.now();
      await controller.pause(controller.jobs[0]!);
      expect(controller.jobs[0]?.state).toBe("paused");
      await controller.resume(controller.jobs[0]!);
      await vi.waitFor(() => expect(controller.jobs[0]?.state).toBe("completed"), { timeout: 2_000 });
      expect(Date.now() - pausedAt).toBeLessThan(2_000);
      expect(calls).toEqual({ chunk: 2, reconcile: 2, control: ["start", "pause", "start"] });
      expect(controller.error).toBe("");
    } finally { controller.dispose(); }
  });
});

describe("[TC-PDFILE-015] the controller reports a retry wait while it lasts", (): void => {
  it("holds the retry time during the wait and drops it when the retry starts", async (): Promise<void> => {
    const { api, calls } = refusingApi((attempt) => attempt === 0 ? rateLimited(1) : undefined);
    const controller = new FileTransferController(api);
    try {
      await controller.prepare("host", "captured", () => sourceFromFiles([new File(["payload"], "file.txt")]));
      await vi.waitFor(() => expect(Object.keys(controller.retrying)).toHaveLength(1));
      const id = controller.jobs[0]!.id;
      const remaining = (controller.retrying[id] ?? 0) - Date.now();
      expect(remaining).toBeGreaterThan(500);
      expect(remaining).toBeLessThanOrEqual(1_000);
      await vi.waitFor(() => expect(calls.chunk).toBe(2), { timeout: 3_000 });
      expect(controller.retrying).toEqual({});
      await vi.waitFor(() => expect(controller.jobs[0]?.state).toBe("completed"));
    } finally { controller.dispose(); }
  });

  it("drops the wait at once when the user pauses", async (): Promise<void> => {
    const { api, calls } = refusingApi(() => rateLimited(30));
    const controller = new FileTransferController(api);
    try {
      await controller.prepare("host", "captured", () => sourceFromFiles([new File(["payload"], "file.txt")]));
      await vi.waitFor(() => expect(Object.keys(controller.retrying)).toHaveLength(1));
      await controller.pause(controller.jobs[0]!);
      expect(controller.retrying).toEqual({});
      expect(calls.chunk).toBe(1);
    } finally { controller.dispose(); }
  });
});

describe("[TC-PDFILE-020] transfer presentation does not change the server lifecycle", () => {
  const job = (): FileTransferView => ({ id: "job", hostId: "host", basePath: "folder", direction: "download", state: "ready", bytes: 10, totalBytes: 10, completedEntries: 1, totalEntries: 1, currentPath: "file", errorCode: "", exclusions: [], archiveBytes: 10, updated: 0, created: 0 });
  it("separates active, attention and history without pretending a browser download completed", () => {
    const controller = new FileTransferController(); const value = job();
    try {
      expect(controller.expanded).toBe(false); expect(controller.group(value)).toBe("attention");
      controller.handedOff = [value.id]; expect(controller.group(value)).toBe("history");
      expect(value.state).toBe("ready");
      controller.nativeDownloads = { job: { id: "job", received: 1, total: 10, state: "progressing" } };
      expect(controller.group(value)).toBe("active");
      controller.nativeDownloads.job = { id: "job", received: 10, total: 10, state: "completed" };
      expect(controller.group(value)).toBe("history");
    } finally { controller.dispose(); }
  });
  it("leaves a cancelled save dialog in attention and coalesces repeated save clicks", async () => {
    let release: () => void = (): void => {};
    const picked = new Promise<void>((resolve) => release = resolve);
    const download = vi.fn(async () => picked);
    vi.stubGlobal("window", { pdmuxDesktop: { isDesktop: true, transfers: { download, status: async () => null } } });
    const controller = new FileTransferController(); const value = job();
    try {
      const first = controller.save(value); const duplicate = controller.save(value);
      expect(download).toHaveBeenCalledTimes(1); release(); await Promise.all([first, duplicate]);
      expect(controller.handedOff).toEqual([]); expect(controller.group(value)).toBe("attention");
      expect(controller.saving).toEqual([]);
    } finally { controller.dispose(); vi.unstubAllGlobals(); }
  });
});
