import { afterEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow, CreateInterruptedDownloadOptions, IpcMainInvokeEvent, Session } from "electron";
import { TransferSources } from "./transfer-source.js";

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
let savePath = "";
mock.module("electron", () => ({
  dialog: {
    showSaveDialog: async (): Promise<{ canceled: boolean; filePath: string }> => ({ canceled: false, filePath: savePath }),
    showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({ canceled: true, filePaths: [] }),
  },
  ipcMain: {
    handle: (name: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void => { handlers.set(name, fn); },
    removeHandler: (name: string): void => { handlers.delete(name); },
  },
}));
const { DesktopFileTransfers, isTransferSender } = await import("./file-transfers.js");
const directories: string[] = [];
afterEach(async (): Promise<void> => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
  handlers.clear();
});
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pdmux-native-transfer-"));
  directories.push(path);
  return path;
}

describe("[TC-PDFILE-009] restricted desktop file transfers", (): void => {
  it("retains empty folders and restricts reads to the selected root and chunk cap", async (): Promise<void> => {
    const root = await directory();
    await mkdir(join(root, "source", "empty"), { recursive: true });
    await writeFile(join(root, "source", "file"), "payload");
    await writeFile(join(root, "outside"), "private");
    const sources = new TransferSources();
    const picked = await sources.select(join(root, "source"));
    expect(picked.entries.map((entry) => entry.path)).toContain("source/empty");
    expect(await sources.read(picked.token, "source/file", 0, 7)).toEqual(new TextEncoder().encode("payload"));
    await expect(sources.read(picked.token, "source/../outside", 0, 7)).rejects.toThrow();
    await expect(sources.read(picked.token, "source/file", 0, 1_048_577)).rejects.toThrow();
    sources.release(picked.token);
    await expect(sources.read(picked.token, "source/file", 0, 7)).rejects.toThrow();
  });
  it("reports excluded symbolic links and rejects stale selected file metadata", async (): Promise<void> => {
    const root = await directory();
    await mkdir(join(root, "source"));
    await writeFile(join(root, "source", "file"), "old");
    const sources = new TransferSources();
    const picked = await sources.select(join(root, "source"));
    await writeFile(join(root, "source", "file"), "changed");
    await expect(sources.read(picked.token, "source/file", 0, 3)).rejects.toThrow("FILES_TRANSFER_SOURCE_CHANGED");
    await symlink(join(root, "source", "file"), join(root, "source", "link"));
    const reviewed = await sources.select(join(root, "source"));
    expect(reviewed.exclusions).toEqual(["source/link"]);
    expect(reviewed.entries.some((entry) => entry.path === "source/link")).toBe(false);
    await expect(sources.read(reviewed.token, "source/link", 0, 7)).rejects.toThrow();
  });
  it("rejects other origins and subframes at the IPC boundary", (): void => {
    expect(isTransferSender("http://localhost:5001/", "http://localhost:5001/", true)).toBe(true);
    expect(isTransferSender("https://example.com/", "http://localhost:5001/", true)).toBe(false);
    expect(isTransferSender("http://localhost:5001/", "http://localhost:5001/", false)).toBe(false);
    expect(isTransferSender("invalid", "http://localhost:5001/", true)).toBe(false);
  });
  it("persists download offsets and reconstructs an interrupted download after restart", async (): Promise<void> => {
    const root = await directory();
    savePath = join(root, "archive.zip");
    const hostId = "11111111-1111-4111-8111-111111111111";
    const jobId = "22222222-2222-4222-8222-222222222222";
    const events = new EventEmitter();
    const item = new EventEmitter();
    let currentUrl = "";
    let resumed = false;
    let received = 0;
    let reconstructed: CreateInterruptedDownloadOptions | undefined;
    const etag = '"' + createHash("sha256").update(Buffer.alloc(100)).digest("hex") + '"';
    let allowed = true;
    Object.assign(item, {
      getURL: (): string => currentUrl, getMimeType: (): string => "application/zip",
      getReceivedBytes: (): number => received, setSavePath: (): void => {},
      isPaused: (): boolean => false, pause: (): void => {},
      resume: (): void => { resumed = true; },
    });
    const session = {
      on: events.on.bind(events), off: events.off.bind(events),
      fetch: async (): Promise<Response> => allowed ? Response.json({ state: "ready", etag, archiveBytes: 100 }) : new Response(null, { status: 403 }),
      createInterruptedDownload: (options: CreateInterruptedDownloadOptions): void => {
        reconstructed = options;
        currentUrl = options.urlChain[0] ?? "";
        events.emit("will-download", { preventDefault: (): void => {} }, item);
      },
    } as unknown as Session;
    const frame = { url: "http://127.0.0.1:5001/" };
    const window = {
      webContents: { mainFrame: frame, downloadURL: (url: string): void => {
        currentUrl = url;
        events.emit("will-download", { preventDefault: (): void => {} }, item);
      } },
    } as unknown as BrowserWindow;
    let manager = new DesktopFileTransfers(window, session, "http://127.0.0.1:5001", root);
    await manager.initialize();
    await manager.download(hostId, jobId);
    received = 40;
    await writeFile(savePath + ".pdmux-download-" + jobId + ".part", Buffer.alloc(40));
    await manager.close();
    item.removeAllListeners();
    frame.url = "http://127.0.0.1:5003/";
    manager = new DesktopFileTransfers(window, session, "http://127.0.0.1:5003", root);
    await manager.initialize();
    await manager.download(hostId, jobId);
    expect(reconstructed?.offset).toBe(40);
    expect(reconstructed?.eTag).toBe(etag);
    expect(reconstructed?.urlChain[0]).toContain("127.0.0.1:5003/api/hosts/");
    expect(resumed).toBe(true);
    const event = { sender: window.webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    allowed = false;
    await expect(manager.download(hostId, jobId)).rejects.toThrow("FILES_TRANSFER_FORBIDDEN");
    expect(await handlers.get("pdmux:transfers:status")?.(event, jobId)).toEqual({ ok: false, code: "FILES_TRANSFER_FORBIDDEN" });
    expect(await handlers.get("pdmux:transfers:cancel-download")?.(event, jobId)).toEqual({ ok: false, code: "FILES_TRANSFER_FORBIDDEN" });
    allowed = true;
    received = 100;
    await writeFile(savePath + ".pdmux-download-" + jobId + ".part", Buffer.alloc(100));
    item.emit("done", {}, "completed");
    await manager.close();
    expect(await readFile(savePath)).toEqual(Buffer.alloc(100));
    const records = JSON.parse(await readFile(join(root, "file-transfers/downloads.json"), "utf8")) as Array<{ state: string }>;
    expect(records[0]?.state).toBe("completed");
  });
});
