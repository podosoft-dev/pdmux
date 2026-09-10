import { describe, expect, it, vi } from "vitest";
import type { FileTransferEntryView, FileTransferView } from "@pdmux/protocol";
import { FileTransferController } from "../src/lib/dashboard/file-transfers/controller.svelte";
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
