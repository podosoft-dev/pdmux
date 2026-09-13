import { dialog, ipcMain, type BrowserWindow, type DownloadItem, type IpcMainInvokeEvent, type Session } from "electron";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, link, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { TransferSources } from "./transfer-source.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TTL = 24 * 60 * 60 * 1000;
const channels = ["pick-folder", "read", "release", "download", "status", "pause-download", "cancel-download"] as const;

export interface NativeDownloadView {
  id: string;
  received: number;
  total: number;
  state: "progressing" | "interrupted" | "completed" | "cancelled";
}
interface DownloadRecord extends NativeDownloadView {
  hostId: string;
  origin: string;
  path: string;
  etag: string;
  updated: number;
  startTime: number;
}
export function isTransferSender(frameUrl: string, appUrl: string, mainFrame: boolean): boolean {
  try { return mainFrame && new URL(frameUrl).origin === new URL(appUrl).origin; }
  catch { return false; }
}
function id(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("FILES_TRANSFER_INVALID");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("FILES_TRANSFER_INVALID");
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("FILES_TRANSFER_INVALID");
  return value;
}
function temporary(record: DownloadRecord): string { return record.path + ".pdmux-download-" + record.id + ".part"; }
function checkpoint(record: DownloadRecord): string { return temporary(record) + ".resume"; }
function cancelled(record: DownloadRecord): boolean { return record.state === "cancelled"; }
async function removePartial(record: DownloadRecord): Promise<void> {
  await Promise.all([temporary(record), checkpoint(record), checkpoint(record) + ".next"]
    .map(path => unlink(path).catch(() => undefined)));
}

/** Native privileges are confined to user-selected roots and fixed transfer URLs. */
export class DesktopFileTransfers {
  private readonly sources = new TransferSources();
  private readonly records = new Map<string, DownloadRecord>();
  private readonly active = new Map<string, DownloadItem>();
  private readonly pending = new Map<string, DownloadRecord>();
  private readonly publishing = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private writes: Promise<void> = Promise.resolve();
  private closing = false;
  private readonly recordPath: string;

  constructor(private readonly window: BrowserWindow, private readonly session: Session, private appUrl: string, userData: string) {
    this.recordPath = join(userData, "file-transfers", "downloads.json");
  }
  setAppUrl(url: string): void { this.appUrl = url; }
  private check(event: IpcMainInvokeEvent): void {
    if (event.sender !== this.window.webContents || !isTransferSender(event.senderFrame?.url ?? "", this.appUrl, event.senderFrame === event.sender.mainFrame)) throw new Error("FILES_TRANSFER_FORBIDDEN");
  }
  private url(hostId: string, transferId: string): string {
    return new URL(`/api/hosts/${id(hostId)}/file-transfers/${id(transferId)}/download`, this.appUrl).href;
  }
  async initialize(): Promise<void> {
    await mkdir(dirname(this.recordPath), { recursive: true, mode: 0o700 });
    try {
      const parsed: unknown = JSON.parse(await readFile(this.recordPath, "utf8"));
      if (Array.isArray(parsed)) for (const item of parsed as unknown[]) {
        if (!item || typeof item !== "object") continue;
        const record = item as Partial<DownloadRecord>;
        if (!record.id || !UUID.test(record.id) || !record.hostId || !UUID.test(record.hostId) ||
          typeof record.path !== "string" || !isAbsolute(record.path) || typeof record.origin !== "string" || typeof record.etag !== "string" ||
          !Number.isSafeInteger(record.received) || !Number.isSafeInteger(record.total) ||
          (record.received ?? -1) < 0 || (record.total ?? 0) <= 0 || record.received! > record.total! ||
          typeof record.updated !== "number" || !Number.isFinite(record.updated) || typeof record.startTime !== "number") continue;
        try { new URL(record.origin); } catch { continue; }
        if (Date.now() - record.updated > TTL) {
          await removePartial(record as DownloadRecord);
          continue;
        }
        if (record.state === "completed" || record.state === "cancelled") {
          await unlink(checkpoint(record as DownloadRecord)).catch(() => undefined);
          continue;
        }
        const saved = await lstat(checkpoint(record as DownloadRecord)).catch(() => null);
        if (saved?.isFile()) {
          await unlink(temporary(record as DownloadRecord)).catch(() => undefined);
          await rename(checkpoint(record as DownloadRecord), temporary(record as DownloadRecord));
          record.received = Math.min(record.received!, saved.size);
        }
        this.records.set(record.id, { ...record, state: "interrupted" } as DownloadRecord);
      }
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    this.session.on("will-download", this.onDownload);
    this.timer = setInterval((): void => { void this.expire().catch(() => undefined); }, 60_000);
    this.timer.unref();
    const register = (name: typeof channels[number], handler: (...args: unknown[]) => unknown): void => {
      ipcMain.handle("pdmux:transfers:" + name, async (event, ...args: unknown[]): Promise<unknown> => {
        try { this.check(event); return { ok: true, value: await handler(...args) }; }
        catch (error: unknown) {
          const code = error instanceof Error && /^(FILES_TRANSFER_|HOST_)[A-Z_]+$/.test(error.message) ? error.message : "FILES_TRANSFER_IO";
          return { ok: false, code };
        }
      });
    };
    register("pick-folder", async (): Promise<unknown> => {
      const result = await dialog.showOpenDialog(this.window, { properties: ["openDirectory"] });
      const selected = result.filePaths[0];
      return result.canceled || !selected ? null : this.sources.select(selected);
    });
    register("read", (token, path, offset, length) => this.sources.read(id(token), text(path), integer(offset), integer(length)));
    register("release", (token): void => this.sources.release(id(token)));
    register("download", (hostId, transferId) => this.download(id(hostId), id(transferId)));
    register("status", async (transferId): Promise<NativeDownloadView | null> => {
      const record = await this.authorizedRecord(id(transferId));
      return record ? { id: record.id, received: record.received, total: record.total, state: record.state } : null;
    });
    register("pause-download", async (transferId): Promise<void> => {
      const record = await this.authorizedRecord(id(transferId));
      if (record) { this.active.get(record.id)?.pause(); record.state = "interrupted"; record.updated = Date.now(); await this.persist(); }
    });
    register("cancel-download", async (transferId): Promise<void> => {
      const key = id(transferId);
      const record = await this.authorizedRecord(key);
      this.active.get(key)?.cancel();
      if (record) { record.state = "cancelled"; await removePartial(record); await this.persist(); }
    });
  }
  private async expire(): Promise<void> {
    for (const [key, record] of this.records) {
      if (Date.now() - record.updated <= TTL || this.active.has(key) || this.publishing.has(key)) continue;
      await removePartial(record);
      this.records.delete(key);
    }
    await this.persist();
  }
  private async authorizedRecord(transferId: string): Promise<DownloadRecord | undefined> {
    const record = this.records.get(transferId);
    if (record) await this.metadata(record.hostId, transferId);
    return record;
  }
  private async metadata(hostId: string, transferId: string): Promise<{ state: string; etag: string; archiveBytes: number }> {
    const response = await this.session.fetch(this.url(hostId, transferId).replace(/\/download$/, ""), { credentials: "include" });
    if (!response.ok) throw new Error("FILES_TRANSFER_FORBIDDEN");
    const job: unknown = await response.json();
    if (!job || typeof job !== "object" || !("state" in job) || typeof job.state !== "string" ||
      !("etag" in job) || typeof job.etag !== "string" || !("archiveBytes" in job) ||
      typeof job.archiveBytes !== "number" || !Number.isSafeInteger(job.archiveBytes) || job.archiveBytes < 0) throw new Error("FILES_TRANSFER_NOT_READY");
    return { state: job.state, etag: job.etag, archiveBytes: job.archiveBytes };
  }
  private async persist(): Promise<void> {
    const snapshot = JSON.stringify([...this.records.values()]);
    this.writes = this.writes.catch(() => undefined).then(async (): Promise<void> => {
      await writeFile(this.recordPath + ".next", snapshot, { mode: 0o600 });
      await rename(this.recordPath + ".next", this.recordPath);
    });
    return this.writes;
  }
  async download(hostId: string, transferId: string): Promise<void> {
    const job = await this.metadata(hostId, transferId);
    if (job.state !== "ready" || !/^"[0-9a-f]{64}"$/.test(job.etag) || !job.archiveBytes) throw new Error("FILES_TRANSFER_NOT_READY");
    const publishing = this.publishing.get(transferId);
    if (publishing) return publishing;
    const running = this.active.get(transferId);
    if (running) { running.resume(); return; }
    if (this.pending.size >= 4) throw new Error("FILES_TRANSFER_LIMIT");
    const url = this.url(hostId, transferId);
    if (this.pending.has(url)) return;
    const origin = new URL(this.appUrl).origin;
    let record = this.records.get(transferId);
    // Loopback ports can change after a local runtime restart; the authenticated
    // job ID, size and immutable ETag are rechecked before reusing partial bytes.
    const local = new URL(this.appUrl).hostname === "127.0.0.1";
    if (record && record.hostId === hostId && record.etag === job.etag && record.total === job.archiveBytes &&
      (record.origin === origin || (local && new URL(record.origin).hostname === "127.0.0.1"))) {
      const saved = await lstat(temporary(record)).catch(() => null);
      if (saved?.isFile() && saved.size === record.total && record.received === record.total) return this.publish(record);
      if (saved?.isFile() && saved.size >= record.received && record.received > 0 && record.received < record.total) {
        record.origin = origin;
        record.state = "interrupted";
        this.pending.set(url, record);
        this.session.createInterruptedDownload({
          path: temporary(record), urlChain: [url], mimeType: "application/zip",
          offset: record.received, length: record.total, eTag: record.etag, startTime: record.startTime,
        });
        return;
      }
    }
    const selected = await dialog.showSaveDialog(this.window, { defaultPath: "files.zip" });
    if (selected.canceled || !selected.filePath) return;
    if (record) await removePartial(record);
    record = { id: transferId, hostId, origin, path: selected.filePath, received: 0, total: job.archiveBytes,
      etag: job.etag, state: "progressing", updated: Date.now(), startTime: Date.now() / 1000 };
    this.records.set(transferId, record);
    await this.persist();
    this.pending.set(url, record);
    this.window.webContents.downloadURL(url);
  }
  private publish(record: DownloadRecord): Promise<void> {
    const pending = this.publishing.get(record.id);
    if (pending) return pending;
    const task = (async (): Promise<void> => {
      record.state = "progressing";
      try {
        const file = await lstat(temporary(record));
        if (!file.isFile() || file.size !== record.total) throw new Error("FILES_TRANSFER_SOURCE_CHANGED");
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(temporary(record), { highWaterMark: 1_048_576 })) {
          if (cancelled(record)) return;
          hash.update(chunk as Buffer);
          record.updated = Date.now();
        }
        if ('"' + hash.digest("hex") + '"' !== record.etag) {
          record.received = 0;
          throw new Error("FILES_TRANSFER_SOURCE_CHANGED");
        }
        if (cancelled(record)) return;
        await rename(temporary(record), record.path);
        await unlink(checkpoint(record)).catch(() => undefined);
        record.state = "completed";
      } catch {
        if (!cancelled(record)) record.state = "interrupted";
      } finally { record.updated = Date.now(); await this.persist(); }
    })().finally((): void => { this.publishing.delete(record.id); });
    this.publishing.set(record.id, task);
    return task;
  }
  private readonly onDownload = (event: Electron.Event, item: DownloadItem): void => {
    const record = this.pending.get(item.getURL());
    if (!record) return;
    this.pending.delete(item.getURL());
    if (!["application/zip", "application/octet-stream"].includes(item.getMimeType())) {
      event.preventDefault(); record.state = "interrupted"; record.updated = Date.now();
      void this.persist().catch(() => undefined);
      return;
    }
    item.setSavePath(temporary(record));
    this.active.set(record.id, item);
    item.on("updated", (_event, state): void => {
      record.received = item.getReceivedBytes();
      record.state = item.isPaused() || state === "interrupted" ? "interrupted" : "progressing";
      if (Date.now() - record.updated >= 1000) {
        record.updated = Date.now();
        void this.persist().catch(() => undefined);
      }
    });
    item.once("done", (_event, state): void => {
      this.active.delete(record.id);
      record.received = item.getReceivedBytes();
      record.updated = Date.now();
      if (state === "completed") {
        void this.publish(record).catch(() => undefined);
      } else {
        record.state = state;
        if (this.closing && state === "cancelled") record.state = "interrupted";
        void this.persist().catch(() => undefined);
      }
    });
    if (record.received > 0) item.resume();
  };
  async close(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    for (const item of this.active.values()) item.pause();
    for (const [key, item] of this.active) {
      const record = this.records.get(key);
      if (record) { record.received = item.getReceivedBytes(); record.state = "interrupted"; record.updated = Date.now(); }
    }
    await Promise.allSettled(this.publishing.values());
    for (const record of this.records.values()) {
      if (record.state === "completed" || record.state === "cancelled" || record.received <= 0) continue;
      const saved = await lstat(temporary(record)).catch(() => null);
      if (!saved?.isFile()) continue;
      // Chromium deletes its partial file on normal shutdown. Preserve an
      // independent directory entry before closing the window/session. Filesystems
      // without hard links use a bounded native copy (reflink when available).
      const staged = checkpoint(record) + ".next";
      await unlink(staged).catch(() => undefined);
      try { await link(temporary(record), staged); }
      catch { await copyFile(temporary(record), staged, constants.COPYFILE_FICLONE); }
      await rename(staged, checkpoint(record));
      record.received = Math.min(record.received, saved.size);
    }
    await this.persist();
    this.session.off("will-download", this.onDownload);
    for (const channel of channels) ipcMain.removeHandler("pdmux:transfers:" + channel);
  }
}
