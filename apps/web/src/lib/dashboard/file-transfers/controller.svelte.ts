import { ApiError } from "@podosoft/podokit-api-client";
import { FILE_TRANSFER_CHUNK_BYTES, type FileTransferEntryView, type FileTransferView } from "@pdmux/protocol/transfer-limits";
import { transferApi } from "./api";
import { chunkDigest, desktopTransfers, fingerprintSource, type NativeDownload, type ScanProgress, type UploadSource } from "./source";

type Choice = "replace" | "skip" | "cancel" | "pause";
export interface TransferConflict { jobId: string; path: string; typeConflict: boolean }
export interface TransferPreparation { phase: "scanning" | "hashing"; hostId: string; basePath: string; path: string; count: number; bytes: number; totalBytes: number }

export function transferErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error && /^(FILES_TRANSFER_|HOST_)/.test(error.message) ? error.message : "FILES_TRANSFER_IO";
}

/** Consecutive 429 or 503 answers an upload waits out before it pauses. */
export const TRANSFER_RETRY_LIMIT = 6;
const TRANSFER_RETRY_MAX_DELAY_MS = 60_000;

/**
 * How long to wait before retrying a transfer request that failed with `error`,
 * or null when it must not be retried. Only 429 (a request budget is spent) and
 * 503 (the API or a dependency is briefly unavailable) are retried: the request
 * was refused before it changed anything. The wait honors `Retry-After` and
 * doubles from one second with each consecutive failure, up to a minute, so
 * without a hint the retries end after about a minute, inside the API's
 * 90-second limit for an upload without requests.
 */
export function transferRetryDelay(error: unknown, failures: number): number | null {
  if (!(error instanceof ApiError) || (error.statusCode !== 429 && error.statusCode !== 503)) return null;
  if (failures >= TRANSFER_RETRY_LIMIT) return null;
  const hinted = (error.retryAfterSeconds ?? 0) * 1_000;
  return Math.min(TRANSFER_RETRY_MAX_DELAY_MS, Math.max(1_000 * 2 ** failures, hinted));
}

/** Thrown out of a retry wait that a pause, cancel or dispose ended. */
class TransferStopped extends Error {}

/** Independent of directory navigation and of the platform's source picker. */
export class FileTransferController {
  jobs = $state<FileTransferView[]>([]);
  preparing = $state<TransferPreparation | null>(null);
  conflict = $state<TransferConflict | null>(null);
  exclusions = $state<string[] | null>(null);
  error = $state("");
  expanded = $state(true);
  handedOff = $state<string[]>([]);
  nativeDownloads = $state<Record<string, NativeDownload>>({});
  removing = $state<string[]>([]);
  /** Uploads waiting out a refused request: job id to the epoch ms when the retry starts. */
  retrying = $state<Record<string, number>>({});
  private readonly sources = new Map<string, UploadSource>();
  private readonly running = new Set<string>();
  private readonly queued = new Set<string>();
  private readonly stopped = new Set<string>();
  private readonly refreshes = new Map<string, Promise<void>>();
  private readonly removed = new Set<string>();
  private readonly wakers = new Map<string, () => void>();
  private resolveConflict: ((choice: Choice) => void) | undefined;
  private resolveExclusions: ((proceed: boolean) => void) | undefined;
  private allChoice: Choice | undefined;
  private cancelledPreparation = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private uploadQueue: Promise<void> = Promise.resolve();

  constructor(private readonly api: typeof transferApi = transferApi, private readonly onFilesChanged: (job: FileTransferView) => void = (): void => {}) {}

  dispose(): void {
    this.disposed = true;
    this.cancelPreparation();
    this.choose("pause");
    for (const id of this.running) this.stopped.add(id);
    for (const wake of [...this.wakers.values()]) wake();
    if (this.timer) clearTimeout(this.timer);
    for (const source of this.sources.values()) void source.release?.().catch(() => undefined);
    this.sources.clear();
  }
  private remember(job: FileTransferView): void {
    if (this.disposed || this.removed.has(job.id)) return;
    const index = this.jobs.findIndex((value) => value.id === job.id);
    if (index >= 0 && (this.jobs[index]?.updated ?? 0) > job.updated) return;
    const previous = this.jobs[index];
    if (index < 0) this.jobs = [job, ...this.jobs];
    else this.jobs = this.jobs.map((value) => value.id === job.id ? job : value);
    if (previous && previous.state !== job.state && job.direction === "upload" && job.completedEntries > 0 &&
      ["completed", "paused", "cancelled", "failed"].includes(job.state)) this.onFilesChanged(job);
  }
  async load(hostId: string): Promise<void> {
    const pending = this.refreshes.get(hostId);
    if (pending) return pending;
    const next = this.api.list(hostId).then(async (jobs): Promise<void> => {
      for (const job of jobs) this.remember(job);
      const desktop = desktopTransfers();
      if (desktop) for (const job of jobs.filter((job) => job.state === "ready")) {
        const download = await desktop.status(job.id);
        if (download) this.nativeDownloads = { ...this.nativeDownloads, [job.id]: download };
      }
      this.poll();
    }).catch((error: unknown): void => { this.error = transferErrorCode(error); })
      .finally((): void => { this.refreshes.delete(hostId); });
    this.refreshes.set(hostId, next);
    return next;
  }
  private poll(): void {
    if (this.disposed || this.timer) return;
    const active = this.jobs.filter((job) => ["queued", "running"].includes(job.state) || this.nativeDownloads[job.id]?.state === "progressing");
    if (!active.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void Promise.all([...new Set(active.map((job) => job.hostId))].map((hostId) => this.load(hostId))).then(() => this.poll());
    }, 1000);
  }
  cancelPreparation(): void { this.cancelledPreparation = true; this.reviewExclusions(false); }
  reviewExclusions(proceed: boolean): void {
    const resolve = this.resolveExclusions;
    this.resolveExclusions = undefined;
    this.exclusions = null;
    resolve?.(proceed);
  }

  async prepare(
    hostId: string, basePath: string, select: (progress: ScanProgress) => Promise<UploadSource | null>,
    resumeJob?: FileTransferView,
  ): Promise<void> {
    if (this.preparing) return;
    this.error = "";
    this.expanded = true;
    this.cancelledPreparation = false;
    this.preparing = { phase: "scanning", hostId, basePath, path: "", count: 0, bytes: 0, totalBytes: 0 };
    let source: UploadSource | null = null;
    let transferred = false;
    try {
      source = await select((path, count): void => {
        if (this.cancelledPreparation) throw new Error("FILES_TRANSFER_PAUSED");
        if (this.preparing) this.preparing = { ...this.preparing, path, count };
      });
      if (!source) return;
      if (this.cancelledPreparation) return;
      if (source.exclusions?.length) {
        this.exclusions = source.exclusions;
        if (!await new Promise<boolean>((resolve): void => { this.resolveExclusions = resolve; })) return;
      }
      this.preparing = { ...this.preparing, phase: "hashing", count: source.entries.length };
      await fingerprintSource(source, (path, bytes, totalBytes): void => {
        if (this.preparing) this.preparing = { ...this.preparing, path, bytes, totalBytes };
      }, () => this.cancelledPreparation);
      if (!source.entries.length) return;
      let job: FileTransferView;
      if (resumeJob) {
        const originals = await this.api.entries(hostId, resumeJob.id);
        const selected = new Map(source.entries.map((entry) => [entry.path, entry]));
        if ((resumeJob.state !== "draft" && selected.size !== originals.length) || originals.some((entry) => {
          const file = selected.get(entry.path);
          return !file || file.kind !== entry.kind || file.size !== entry.size || file.fingerprint !== entry.fingerprint;
        })) throw new Error("FILES_TRANSFER_SOURCE_CHANGED");
        job = resumeJob;
        if (job.state === "draft") {
          const ids = new Map(originals.map((entry) => [entry.path, entry.id]));
          for (const entry of source.entries) entry.id = ids.get(entry.path) ?? entry.id;
          for (let offset = 0; offset < source.entries.length; offset += 250) {
            if (this.cancelledPreparation) return;
            job = await this.api.manifest(hostId, job.id, source.entries.slice(offset, offset + 250));
            this.remember(job);
          }
        }
      } else {
        job = await this.api.create(hostId, { id: crypto.randomUUID(), direction: "upload", basePath, selection: [] });
        this.remember(job);
        for (let offset = 0; offset < source.entries.length; offset += 250) {
          if (this.cancelledPreparation) return;
          job = await this.api.manifest(hostId, job.id, source.entries.slice(offset, offset + 250));
          this.remember(job);
        }
      }
      if (this.cancelledPreparation) return;
      this.sources.set(job.id, source);
      transferred = true;
      this.preparing = null;
      await this.resume(job);
    } catch (error: unknown) {
      if (!(error instanceof DOMException && error.name === "AbortError") && !this.cancelledPreparation) this.error = transferErrorCode(error);
    } finally {
      this.preparing = null;
      if (source && !transferred) await source.release?.();
    }
  }
  async download(hostId: string, basePath: string, selection: string[]): Promise<void> {
    this.error = "";
    this.expanded = true;
    try {
      const job = await this.api.create(hostId, { id: crypto.randomUUID(), direction: "download", basePath, selection });
      this.remember(await this.api.control(hostId, job.id, "start"));
      this.poll();
    } catch (error: unknown) { this.error = transferErrorCode(error); }
  }
  hasSource(id: string): boolean { return this.sources.has(id); }
  async needsFolder(job: FileTransferView): Promise<boolean> {
    return (await this.api.entries(job.hostId, job.id)).some((entry) => entry.kind === "directory");
  }
  async resume(job: FileTransferView): Promise<void> {
    this.error = "";
    this.stopped.delete(job.id);
    try {
      if (job.direction === "upload" && !this.sources.has(job.id)) throw new Error("FILES_TRANSFER_RESELECT");
      const updated = await this.api.control(job.hostId, job.id, "start");
      this.remember(updated);
      this.poll();
      // A run that a pause is still ending would not see this resume, so another
      // is queued behind it; it returns at once if that run finished the job.
      if (job.direction === "upload" && !this.queued.has(job.id)) {
        this.queued.add(job.id);
        this.uploadQueue = this.uploadQueue.catch(() => undefined).then(async (): Promise<void> => {
          this.queued.delete(job.id);
          this.running.add(job.id);
          this.allChoice = undefined;
          await this.upload(job);
        }).finally((): void => { this.running.delete(job.id); });
      }
    } catch (error: unknown) { this.error = transferErrorCode(error); }
  }
  async pause(job: FileTransferView): Promise<void> {
    this.stopped.add(job.id);
    this.wakers.get(job.id)?.();
    if (this.conflict?.jobId === job.id) this.choose("pause");
    try { this.remember(await this.api.control(job.hostId, job.id, "pause")); }
    catch (error: unknown) { this.error = transferErrorCode(error); }
  }
  async cancel(job: FileTransferView): Promise<void> {
    this.stopped.add(job.id);
    this.wakers.get(job.id)?.();
    if (this.conflict?.jobId === job.id) this.choose("cancel");
    try {
      if (this.nativeDownloads[job.id]) await desktopTransfers()?.cancelDownload(job.id);
      this.remember(await this.api.control(job.hostId, job.id, "cancel"));
      await this.sources.get(job.id)?.release?.();
      this.sources.delete(job.id);
    } catch (error: unknown) { this.error = transferErrorCode(error); }
  }
  async remove(job: FileTransferView): Promise<void> {
    if (this.removing.includes(job.id)) return;
    this.removing = [...this.removing, job.id];
    this.error = "";
    try {
      try { await this.api.remove(job.hostId, job.id); }
      catch (error: unknown) {
        // The server may have expired the record since the last list response.
        if (transferErrorCode(error) !== "FILES_TRANSFER_NOT_FOUND") throw error;
      }
      this.removed.add(job.id);
      this.jobs = this.jobs.filter((value) => value.id !== job.id);
      this.handedOff = this.handedOff.filter((id) => id !== job.id);
      if (this.nativeDownloads[job.id]) {
        const downloads = { ...this.nativeDownloads };
        delete downloads[job.id];
        this.nativeDownloads = downloads;
      }
      await this.sources.get(job.id)?.release?.().catch(() => undefined);
      this.sources.delete(job.id);
    } catch { this.error = "FILES_TRANSFER_CLEAR_FAILED"; }
    finally { this.removing = this.removing.filter((id) => id !== job.id); }
  }
  async removeFinished(): Promise<void> {
    const finished = this.jobs.filter((job) => ["completed", "cancelled", "expired"].includes(job.state));
    await Promise.all(finished.map((job) => this.remove(job)));
  }
  choose(choice: Choice, all = false): void {
    if (all && (choice === "replace" || choice === "skip")) this.allChoice = choice;
    const resolve = this.resolveConflict;
    this.resolveConflict = undefined;
    this.conflict = null;
    resolve?.(choice);
  }
  private async collision(job: FileTransferView, entry: FileTransferEntryView, error: unknown): Promise<Choice> {
    const code = transferErrorCode(error);
    if (!["FILES_TRANSFER_CONFLICT", "FILES_TRANSFER_TYPE_CONFLICT", "FILES_TRANSFER_LINK"].includes(code)) throw error;
    const typeConflict = code !== "FILES_TRANSFER_CONFLICT";
    if (this.allChoice && (!typeConflict || this.allChoice !== "replace")) return this.allChoice;
    this.conflict = { jobId: job.id, path: entry.path, typeConflict };
    return new Promise<Choice>((resolve): void => { this.resolveConflict = resolve; });
  }
  /** Waits `delayMs` and then rejects with TransferStopped if the upload was stopped meanwhile. */
  private async backOff(jobId: string, delayMs: number): Promise<void> {
    await new Promise<void>((resolve): void => {
      const wake = (): void => {
        clearTimeout(timer);
        if (this.wakers.get(jobId) === wake) {
          this.wakers.delete(jobId);
          const waiting = { ...this.retrying };
          delete waiting[jobId];
          this.retrying = waiting;
        }
        resolve();
      };
      const timer = setTimeout(wake, delayMs);
      this.wakers.set(jobId, wake);
      this.retrying = { ...this.retrying, [jobId]: Date.now() + delayMs };
    });
    if (this.stopped.has(jobId) || this.disposed) throw new TransferStopped();
  }
  /** Runs a request that changes nothing, retrying it after 429 and 503 answers. */
  private async read<T>(jobId: string, request: () => Promise<T>): Promise<T> {
    for (let failures = 0; ; failures++) {
      try { return await request(); }
      catch (error: unknown) {
        const delay = transferRetryDelay(error, failures);
        if (delay === null) throw error;
        await this.backOff(jobId, delay);
      }
    }
  }
  private async upload(job: FileTransferView): Promise<void> {
    try {
      while (!this.stopped.has(job.id) && !this.disposed) {
        const state = await this.read(job.id, () => this.api.get(job.hostId, job.id));
        this.remember(state);
        if (state.state === "running") break;
        if (state.state !== "queued") return;
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
      }
      const source = this.sources.get(job.id);
      if (!source) throw new Error("FILES_TRANSFER_RESELECT");
      const entries = await this.read(job.id, () => this.api.entries(job.hostId, job.id));
      const skipped: string[] = [];
      // Refused requests in a row; a chunk or commit the API accepts resets it.
      let failures = 0;
      // Parent directories must exist before a child file is staged.
      entries.sort((left, right) => left.path.localeCompare(right.path));
      for (let entry of entries) {
        if (this.stopped.has(job.id) || this.disposed) return;
        if (entry.state !== "pending" || skipped.some((prefix) => entry.path.startsWith(prefix + "/"))) continue;
        while (!this.stopped.has(job.id)) {
          try {
            if (entry.kind === "file") {
              entry = await this.api.reconcile(job.hostId, job.id, entry.id);
              if (entry.state === "committed") break;
              let offset = entry.offset;
              if (offset < entry.size || entry.size === 0) do {
                if (this.stopped.has(job.id) || this.disposed) return;
                const bytes = await source.read(entry.path, offset, Math.min(FILE_TRANSFER_CHUNK_BYTES, entry.size - offset));
                if (bytes.length !== Math.min(FILE_TRANSFER_CHUNK_BYTES, entry.size - offset)) throw new Error("FILES_TRANSFER_SOURCE_CHANGED");
                entry = await this.api.chunk(job.hostId, job.id, entry.id, offset, await chunkDigest(bytes), bytes);
                failures = 0;
                offset = entry.offset;
                this.remember(await this.api.get(job.hostId, job.id));
              } while (offset < entry.size);
            }
            await this.api.commit(job.hostId, job.id, entry.id);
            failures = 0;
            this.remember(await this.api.get(job.hostId, job.id));
            break;
          } catch (error: unknown) {
            if (this.stopped.has(job.id)) return;
            const delay = transferRetryDelay(error, failures);
            if (delay !== null) {
              // Reconciling again resumes from the bytes the agent holds, whichever request was refused.
              failures++;
              await this.backOff(job.id, delay);
              continue;
            }
            const choice = await this.collision(job, entry, error);
            if (choice === "pause" || this.disposed) return;
            if (choice === "cancel") { await this.cancel(job); return; }
            entry = await this.read(job.id, () => this.api.decision(job.hostId, job.id, entry.id, choice));
            if (choice === "skip") { skipped.push(entry.path); break; }
          }
        }
      }
      this.remember(await this.api.get(job.hostId, job.id));
      await source.release?.();
      this.sources.delete(job.id);
    } catch (error: unknown) {
      if (error instanceof TransferStopped) return;
      this.error = transferErrorCode(error);
      await this.pause(job);
    }
  }
  async save(job: FileTransferView): Promise<void> {
    try {
      const desktop = desktopTransfers();
      if (desktop) await desktop.download(job.hostId, job.id);
      else {
        const anchor = document.createElement("a");
        anchor.href = this.api.url(job.hostId, job.id);
        anchor.download = "";
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      }
      this.handedOff = [...new Set([...this.handedOff, job.id])];
      await this.load(job.hostId);
    } catch (error: unknown) { this.error = transferErrorCode(error); }
  }

  async pauseDownload(job: FileTransferView): Promise<void> {
    try { await desktopTransfers()?.pauseDownload(job.id); await this.load(job.hostId); }
    catch (error: unknown) { this.error = transferErrorCode(error); }
  }
  async cancelDownload(job: FileTransferView): Promise<void> {
    try { await desktopTransfers()?.cancelDownload(job.id); await this.load(job.hostId); }
    catch (error: unknown) { this.error = transferErrorCode(error); }
  }
}
