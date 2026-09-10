import { FILE_TRANSFER_CHUNK_BYTES, type FileTransferEntryView, type FileTransferView } from "@pdmux/protocol";
import { transferApi } from "./api";
import { chunkDigest, desktopTransfers, fingerprintSource, type NativeDownload, type ScanProgress, type UploadSource } from "./source";

type Choice = "replace" | "skip" | "cancel" | "pause";
export interface TransferConflict { jobId: string; path: string; typeConflict: boolean }
export interface TransferPreparation { phase: "scanning" | "hashing"; hostId: string; basePath: string; path: string; count: number; bytes: number; totalBytes: number }

export function transferErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error && /^(FILES_TRANSFER_|HOST_)/.test(error.message) ? error.message : "FILES_TRANSFER_IO";
}

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
  private readonly sources = new Map<string, UploadSource>();
  private readonly running = new Set<string>();
  private readonly stopped = new Set<string>();
  private readonly refreshes = new Map<string, Promise<void>>();
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
    if (this.timer) clearTimeout(this.timer);
    for (const source of this.sources.values()) void source.release?.().catch(() => undefined);
    this.sources.clear();
  }
  private remember(job: FileTransferView): void {
    if (this.disposed) return;
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
      if (job.direction === "upload" && !this.running.has(job.id)) {
        this.running.add(job.id);
        this.uploadQueue = this.uploadQueue.catch(() => undefined).then(async (): Promise<void> => {
          this.allChoice = undefined;
          await this.upload(job);
        }).finally((): void => { this.running.delete(job.id); });
      }
    } catch (error: unknown) { this.error = transferErrorCode(error); }
  }
  async pause(job: FileTransferView): Promise<void> {
    this.stopped.add(job.id);
    if (this.conflict?.jobId === job.id) this.choose("pause");
    try { this.remember(await this.api.control(job.hostId, job.id, "pause")); }
    catch (error: unknown) { this.error = transferErrorCode(error); }
  }
  async cancel(job: FileTransferView): Promise<void> {
    this.stopped.add(job.id);
    if (this.conflict?.jobId === job.id) this.choose("cancel");
    try {
      if (this.nativeDownloads[job.id]) await desktopTransfers()?.cancelDownload(job.id);
      this.remember(await this.api.control(job.hostId, job.id, "cancel"));
      await this.sources.get(job.id)?.release?.();
      this.sources.delete(job.id);
    } catch (error: unknown) { this.error = transferErrorCode(error); }
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
  private async upload(job: FileTransferView): Promise<void> {
    try {
      while (!this.stopped.has(job.id) && !this.disposed) {
        const state = await this.api.get(job.hostId, job.id);
        this.remember(state);
        if (state.state === "running") break;
        if (state.state !== "queued") return;
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
      }
      const source = this.sources.get(job.id);
      if (!source) throw new Error("FILES_TRANSFER_RESELECT");
      const entries = await this.api.entries(job.hostId, job.id);
      const skipped: string[] = [];
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
                offset = entry.offset;
                this.remember(await this.api.get(job.hostId, job.id));
              } while (offset < entry.size);
            }
            await this.api.commit(job.hostId, job.id, entry.id);
            this.remember(await this.api.get(job.hostId, job.id));
            break;
          } catch (error: unknown) {
            if (this.stopped.has(job.id)) return;
            const choice = await this.collision(job, entry, error);
            if (choice === "pause" || this.disposed) return;
            if (choice === "cancel") { await this.cancel(job); return; }
            entry = await this.api.decision(job.hostId, job.id, entry.id, choice);
            if (choice === "skip") { skipped.push(entry.path); break; }
          }
        }
      }
      this.remember(await this.api.get(job.hostId, job.id));
      await source.release?.();
      this.sources.delete(job.id);
    } catch (error: unknown) {
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
