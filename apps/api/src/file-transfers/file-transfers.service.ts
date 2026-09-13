import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, stat, statfs, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { In, LessThan, type DataSource, type Repository } from "typeorm";
import ZipStream from "zip-stream";
import {
  FILE_TRANSFER_CAPABILITY, FILE_TRANSFER_CHUNK_BYTES, FILE_TRANSFER_MAX_BYTES,
  FILE_TRANSFER_MAX_ENTRIES, FILE_TRANSFER_TTL_MS,
  type FileTransferManifestEntry, type FileTransferView, type FsTransferRequest, type FsTransferResult,
} from "@pdmux/protocol";
import type { AgentFilesService } from "../agents/agent-files.service";
import type { HostsService } from "../hosts/hosts.service";
import { AppException } from "../common/app-exception";
import { FileTransfer, FileTransferEntry } from "./file-transfer.entity";

export interface TransferOwner { userId: string; organizationId: string; hostId: string }
export interface CreateTransfer { id: string; direction: "upload" | "download"; basePath: string; selection: string[] }
export interface TransferAgent {
  transfer(scope: string, hostId: string, input: Omit<Partial<FsTransferRequest>, "requestId"> & Pick<FsTransferRequest, "transferId" | "entryId" | "action" | "path">): Promise<FsTransferResult>;
}
const closed = ["completed", "cancelled", "expired"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{64}$/;

export function transferPath(path: string, root = false): string {
  if (root && path === "") return path;
  if (!path || path.length > 1024 || /[\\\x00:]/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === ".." ||
      part === ".pdmux-file-transfers" || part.startsWith(".pdmux-transfer-"))) {
    throw new AppException("FILES_TRANSFER_PATH", "Invalid transfer path", 400);
  }
  return path;
}
function destination(job: FileTransfer, entry: Pick<FileTransferEntry, "path">): string {
  return transferPath(job.basePath ? `${job.basePath}/${entry.path}` : entry.path);
}
function sha256(data: Uint8Array | string): string { return createHash("sha256").update(data).digest("hex"); }
function fail(code: string, status = 409): never { throw new AppException(code, "The file transfer cannot continue", status); }
function limit(env: NodeJS.ProcessEnv, key: string, fallback: number, maximum: number): number {
  const value = Number(env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${key}`);
  return value;
}

export class FileTransfersService {
  readonly spool: string;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly spoolBytes: number;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly workers = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly agent: TransferAgent | AgentFilesService,
    private readonly hosts: Pick<HostsService, "get">,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.spool = resolve(env.FILE_TRANSFER_DIR ?? "data/file-transfers");
    this.maxBytes = limit(env, "FILE_TRANSFER_MAX_BYTES", FILE_TRANSFER_MAX_BYTES, FILE_TRANSFER_MAX_BYTES);
    this.maxEntries = limit(env, "FILE_TRANSFER_MAX_ENTRIES", FILE_TRANSFER_MAX_ENTRIES, FILE_TRANSFER_MAX_ENTRIES);
    this.spoolBytes = limit(env, "FILE_TRANSFER_SPOOL_BYTES", 20 * 1024 ** 3, Number.MAX_SAFE_INTEGER);
  }
  private jobRepo(): Repository<FileTransfer> { return this.dataSource.getRepository(FileTransfer); }
  private entryRepo(): Repository<FileTransferEntry> { return this.dataSource.getRepository(FileTransferEntry); }

  async initialize(): Promise<void> {
    this.stopping = false;
    await mkdir(this.spool, { recursive: true, mode: 0o700 });
    await this.jobRepo().update({ state: In(["running", "queued"]) }, { state: "paused", errorCode: "FILES_TRANSFER_RESTARTED" });
    for (const name of await readdir(this.spool)) {
      if (/^[0-9a-f-]{36}\.partial$/.test(name)) await unlink(join(this.spool, name));
    }
    await this.cleanup();
    this.timer = setInterval(() => { void this.cleanup().catch(() => undefined); }, 60_000);
    this.timer.unref();
  }
  async close(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled(this.workers.values());
  }
  private async locked<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.locks.set(key, next);
    try { return await next; }
    finally { if (this.locks.get(key) === next) this.locks.delete(key); }
  }
  private async authorize(owner: TransferOwner): Promise<void> {
    const host = await this.hosts.get(owner.organizationId, owner.hostId);
    if (!host.enabled) fail("HOST_DISABLED");
    if (!host.capabilities?.includes(FILE_TRANSFER_CAPABILITY)) fail("HOST_FILES_TRANSFER_UNSUPPORTED");
  }
  async get(owner: TransferOwner, id: string): Promise<FileTransfer> {
    if (!uuid.test(id)) fail("FILES_TRANSFER_INVALID", 400);
    await this.authorize(owner);
    const job = await this.jobRepo().findOneBy({ id, ...owner });
    if (!job) fail("FILES_TRANSFER_NOT_FOUND", 404);
    if (!closed.includes(job.state as typeof closed[number]) && Date.now() - job.updated >= FILE_TRANSFER_TTL_MS) {
      await this.jobRepo().update(job.id, { state: "expired" });
      job.state = "expired";
    }
    return job;
  }
  async list(owner: TransferOwner): Promise<FileTransferView[]> {
    await this.authorize(owner);
    return this.jobRepo().find({ where: owner, order: { created: "DESC" }, take: 100 });
  }
  async entries(owner: TransferOwner, id: string): Promise<FileTransferEntry[]> {
    await this.get(owner, id);
    return this.entryRepo().find({ where: { transferId: id }, order: { path: "ASC" } });
  }
  async create(owner: TransferOwner, input: CreateTransfer): Promise<FileTransfer> {
    await this.authorize(owner);
    if (!uuid.test(input.id)) fail("FILES_TRANSFER_INVALID", 400);
    transferPath(input.basePath, true);
    if (input.selection.length > 250 || (input.direction === "download" && !input.selection.length)) fail("FILES_TRANSFER_LIMIT", 400);
    input.selection.forEach((path) => transferPath(path));
    return this.locked("create:" + owner.hostId, async () => {
      const existing = await this.jobRepo().findOneBy({ id: input.id });
      if (existing) {
        if (existing.userId !== owner.userId || existing.organizationId !== owner.organizationId || existing.hostId !== owner.hostId) fail("FILES_TRANSFER_NOT_FOUND", 404);
        if (existing.direction !== input.direction || existing.basePath !== input.basePath || JSON.stringify(existing.selection) !== JSON.stringify(input.selection)) fail("FILES_TRANSFER_INVALID", 400);
        return existing;
      }
      if (await this.jobRepo().countBy({ ...owner, state: In(["draft", "queued", "running", "paused", "failed", "ready"]) }) >= 32) fail("FILES_TRANSFER_LIMIT", 429);
      return this.jobRepo().save(this.jobRepo().create({
        ...owner, ...input, state: "draft", bytes: 0, totalBytes: 0, completedEntries: 0, totalEntries: 0,
        currentPath: "", errorCode: "", exclusions: [], archiveBytes: 0, etag: "", updated: Date.now(), created: Date.now(),
      }));
    });
  }
  async manifest(owner: TransferOwner, id: string, items: FileTransferManifestEntry[]): Promise<FileTransfer> {
    return this.locked("manifest", async () => {
      const job = await this.get(owner, id);
      if (job.direction !== "upload" || job.state !== "draft") fail("FILES_TRANSFER_STATE");
      if (items.length > 250) fail("FILES_TRANSFER_LIMIT", 400);
      for (const item of items) {
        transferPath(item.path);
        destination(job, item);
        if (!uuid.test(item.id) || !Number.isSafeInteger(item.size) || item.size < 0 ||
          (item.kind !== "file" && item.kind !== "directory") ||
          (item.kind === "directory" && item.size !== 0) ||
          (item.kind === "file" && !digestPattern.test(item.fingerprint))) fail("FILES_TRANSFER_INVALID", 400);
      }
      await this.dataSource.transaction(async (manager) => {
        const entries = manager.getRepository(FileTransferEntry);
        for (const item of items) {
          const old = await entries.findOneBy({ id: item.id });
          if (old) {
            if (old.transferId !== id || old.path !== item.path || old.kind !== item.kind || old.size !== item.size || old.fingerprint !== item.fingerprint) fail("FILES_TRANSFER_SOURCE_CHANGED");
            continue;
          }
          if (await entries.existsBy({ transferId: id, path: item.path })) fail("FILES_TRANSFER_INVALID", 400);
          await entries.save(entries.create({ ...item, transferId: id, offset: 0, state: "pending", replace: false }));
        }
        const all = await entries.findBy({ transferId: id });
        const bytes = all.reduce((total, entry) => total + entry.size, 0);
        if (all.length > this.maxEntries || bytes > this.maxBytes) fail("FILES_TRANSFER_LIMIT", 413);
        await manager.getRepository(FileTransfer).update(id, { totalEntries: all.length, totalBytes: bytes, updated: Date.now() });
      });
      return this.get(owner, id);
    });
  }
  private async ask(job: FileTransfer, entry: FileTransferEntry, action: FsTransferRequest["action"], extra: Partial<FsTransferRequest> = {}): Promise<FsTransferResult> {
    return this.agent.transfer(job.organizationId, job.hostId, {
      transferId: job.id, entryId: entry.id, path: destination(job, entry), size: entry.size,
      action, modified: entry.modified, ...extra,
    });
  }
  async control(owner: TransferOwner, id: string, action: "start" | "pause" | "cancel"): Promise<FileTransfer> {
    // Pause/cancel must not wait for a multi-gigabyte ZIP worker holding the host.
    const job = await this.get(owner, id);
    if (closed.includes(job.state as typeof closed[number])) return job;
    if (action === "pause" && job.state === "ready") return job;
    if (action === "pause" || action === "cancel") {
      await this.jobRepo().update(id, { state: action === "pause" ? "paused" : "cancelled", updated: Date.now() });
      if (action === "cancel") void this.locked(owner.hostId, () => this.discard(job)).catch(() => undefined);
      void this.advance(owner.hostId).catch(() => undefined);
      return this.get(owner, id);
    }
    if (job.state === "ready" || job.state === "running" || job.state === "queued") return job;
    if (job.direction === "upload" && job.totalEntries === 0) fail("FILES_TRANSFER_EMPTY", 400);
    if (job.direction === "upload") {
      const entries = await this.entryRepo().findBy({ transferId: id });
      const files = new Set(entries.filter((entry) => entry.kind === "file").map((entry) => entry.path));
      for (const entry of entries) {
        const parts = entry.path.split("/");
        for (let i = 1; i < parts.length; i++) {
          if (files.has(parts.slice(0, i).join("/"))) fail("FILES_TRANSFER_TYPE_CONFLICT");
        }
      }
    }
    await this.jobRepo().update(id, { state: "queued", errorCode: "", updated: Date.now() });
    this.schedule(owner, id);
    return this.get(owner, id);
  }
  private schedule(owner: TransferOwner, id: string): void {
    if (this.workers.has(id) || this.stopping) return;
    const worker = this.locked(owner.hostId, async () => {
      const job = await this.get(owner, id);
      if (job.state !== "queued") return;
      const busy = await this.jobRepo().findOneBy({ hostId: job.hostId, state: "running" });
      if (busy && busy.id !== id) return;
      await this.jobRepo().update(id, { state: "running", updated: Date.now() });
      job.state = "running";
      if (job.direction === "download") await this.prepareDownload(job);
    }).catch(async (error: unknown) => {
      const job = await this.jobRepo().findOneBy({ id });
      if (job && !["paused", "cancelled", "expired"].includes(job.state)) {
        const diskFull = error instanceof Error && "code" in error && ["ENOSPC", "EDQUOT"].includes(String(error.code));
        await this.jobRepo().update(id, { state: "failed", errorCode: error instanceof AppException ? error.code : diskFull ? "FILES_TRANSFER_DISK_FULL" : "FILES_TRANSFER_IO" });
      }
    }).finally(() => {
      this.workers.delete(id);
      void this.advance(owner.hostId).catch(() => undefined);
    });
    this.workers.set(id, worker);
  }
  private async advance(hostId: string): Promise<void> {
    if (this.stopping || await this.jobRepo().existsBy({ hostId, state: "running" })) return;
    const next = await this.jobRepo().findOne({ where: { hostId, state: "queued" }, order: { created: "ASC" } });
    if (next) this.schedule(next, next.id);
  }
  private async active(owner: TransferOwner, id: string, entryId: string): Promise<[FileTransfer, FileTransferEntry]> {
    if (!uuid.test(entryId)) fail("FILES_TRANSFER_INVALID", 400);
    const job = await this.get(owner, id);
    if (job.direction !== "upload" || job.state !== "running") fail("FILES_TRANSFER_STATE");
    const entry = await this.entryRepo().findOneBy({ id: entryId, transferId: id });
    if (!entry) fail("FILES_TRANSFER_NOT_FOUND", 404);
    return [job, entry];
  }
  async reconcile(owner: TransferOwner, id: string, entryId: string): Promise<FileTransferEntry> {
    return this.locked(owner.hostId, async () => {
      const [job, entry] = await this.active(owner, id, entryId);
      if (entry.kind === "directory" || entry.state === "skipped") return entry;
      const answer = await this.ask(job, entry, "stat");
      if (answer.offset > entry.size || answer.offset < 0) fail("FILES_TRANSFER_RESPONSE", 502);
      entry.offset = answer.offset;
      if (answer.committed) entry.state = "committed";
      await this.entryRepo().save(entry);
      await this.progress(job.id, entry.path);
      return entry;
    });
  }
  async decide(owner: TransferOwner, id: string, entryId: string, action: "replace" | "skip"): Promise<FileTransferEntry> {
    return this.locked(owner.hostId, async () => {
      const [job, entry] = await this.active(owner, id, entryId);
      if (entry.state !== "pending") return entry;
      if (action === "skip") {
        if (entry.kind === "file") await this.ask(job, entry, "discard");
        entry.state = "skipped";
        await this.entryRepo().save(entry);
        // Skipping a conflicting directory also skips its descendants.
        if (entry.kind === "directory") {
          for (const child of await this.entryRepo().findBy({ transferId: id })) {
            if (child.path.startsWith(entry.path + "/") && child.state === "pending") await this.entryRepo().update(child.id, { state: "skipped" });
          }
        }
      } else {
        const result = await this.ask(job, entry, "stat");
        if (entry.kind !== "file" || !["missing", "file"].includes(result.entries[0]?.kind ?? "")) fail("FILES_TRANSFER_TYPE_CONFLICT");
        entry.replace = true;
        await this.entryRepo().save(entry);
      }
      await this.progress(id, entry.path);
      return entry;
    });
  }
  async chunk(owner: TransferOwner, id: string, entryId: string, offset: number, digest: string, data: Uint8Array): Promise<FileTransferEntry> {
    if (data.byteLength > FILE_TRANSFER_CHUNK_BYTES || !digestPattern.test(digest) || sha256(data) !== digest ||
      !Number.isSafeInteger(offset) || offset < 0) fail("FILES_TRANSFER_CHUNK", 400);
    return this.locked(owner.hostId, async () => {
      const [job, entry] = await this.active(owner, id, entryId);
      if (entry.kind !== "file" || entry.state !== "pending") fail("FILES_TRANSFER_STATE");
      if (offset === 0) {
        const target = await this.ask(job, entry, "stat");
        const kind = target.entries[0]?.kind;
        if (kind !== "missing" && !target.committed && (!entry.replace || kind !== "file")) {
          fail(kind === "file" ? "FILES_TRANSFER_CONFLICT" : "FILES_TRANSFER_TYPE_CONFLICT");
        }
      }
      const answer = await this.ask(job, entry, "write", { offset, digest, data: Buffer.from(data).toString("base64") });
      if (answer.offset < offset + data.byteLength || answer.offset > entry.size) fail("FILES_TRANSFER_RESPONSE", 502);
      entry.offset = answer.offset;
      await this.entryRepo().save(entry);
      await this.progress(id, entry.path);
      return entry;
    });
  }
  async commit(owner: TransferOwner, id: string, entryId: string): Promise<FileTransferEntry> {
    return this.locked(owner.hostId, async () => {
      const [job, entry] = await this.active(owner, id, entryId);
      if (entry.state !== "pending") return entry;
      const result = await this.ask(job, entry, entry.kind === "directory" ? "mkdir" : "commit", { digest: entry.fingerprint, replace: entry.replace });
      if (!result.committed) fail("FILES_TRANSFER_RESPONSE", 502);
      entry.state = "committed";
      entry.offset = entry.size;
      await this.entryRepo().save(entry);
      await this.progress(id, entry.path);
      return entry;
    });
  }
  private async progress(id: string, currentPath: string): Promise<void> {
    const summary = await this.entryRepo().createQueryBuilder("entry")
      .select("COUNT(*)", "total")
      .addSelect("SUM(CASE WHEN entry.state <> 'pending' THEN 1 ELSE 0 END)", "done")
      .addSelect("SUM(CASE WHEN entry.state = 'skipped' THEN 0 ELSE entry.offset END)", "bytes")
      .where("entry.transferId = :id", { id })
      .getRawOne<{ total: number | string; done: number | string | null; bytes: number | string | null }>();
    const done = Number(summary?.done ?? 0);
    const total = Number(summary?.total ?? 0);
    await this.jobRepo().update(id, {
      bytes: Number(summary?.bytes ?? 0),
      completedEntries: done, currentPath, updated: Date.now(),
    });
    const job = await this.jobRepo().findOneBy({ id });
    if (job?.direction === "upload" && total > 0 && done === total && job.state === "running") {
      await this.jobRepo().update(id, { state: "completed" });
      void this.advance(job.hostId).catch(() => undefined);
    }
  }
  private async checkpoint(job: FileTransfer): Promise<void> {
    const current = await this.jobRepo().findOneBy({ id: job.id });
    if (this.stopping || current?.state !== "running") fail("FILES_TRANSFER_PAUSED");
  }
  private async scan(job: FileTransfer): Promise<FileTransferEntry[]> {
    await this.entryRepo().delete({ transferId: job.id });
    const entries: FileTransferEntry[] = [];
    const seen = new Set<string>();
    const exclusions: string[] = [];
    let totalBytes = 0;
    const visit = async (relative: string): Promise<void> => {
      if (seen.has(relative)) return;
      seen.add(relative);
      if (seen.size > this.maxEntries) fail("FILES_TRANSFER_LIMIT", 413);
      await this.checkpoint(job);
      const entry = this.entryRepo().create({
        id: randomUUID(), transferId: job.id, path: transferPath(relative), size: 0, offset: 0,
        kind: "file", fingerprint: "", modified: "", state: "pending", replace: false,
      });
      const answer = await this.ask(job, entry, "stat");
      const info = answer.entries[0];
      if (!info || info.kind === "missing") fail("FILES_TRANSFER_SOURCE_CHANGED");
      if (info.kind === "link" || info.kind === "special") { exclusions.push(relative); return; }
      entry.kind = info.kind;
      entry.size = info.size;
      entry.modified = info.modified;
      entries.push(entry);
      totalBytes += entry.size;
      if (entries.length > this.maxEntries || totalBytes > this.maxBytes) fail("FILES_TRANSFER_LIMIT", 413);
      if (entry.kind === "directory") {
        let offset = 0;
        do {
          const page = await this.ask(job, entry, "list", { offset });
          for (const child of page.entries) {
            const prefix = job.basePath ? job.basePath + "/" : "";
            if (!child.path.startsWith(prefix)) fail("FILES_TRANSFER_RESPONSE", 502);
            const childPath = child.path.slice(prefix.length);
            if (!childPath.startsWith(relative + "/") || childPath.slice(relative.length + 1).includes("/")) fail("FILES_TRANSFER_RESPONSE", 502);
            await visit(childPath);
          }
          if (page.next === null) break;
          if (page.next <= offset) fail("FILES_TRANSFER_RESPONSE", 502);
          offset = page.next;
        } while (true);
      }
    };
    for (const path of [...job.selection].sort()) await visit(path);
    await this.entryRepo().save(entries, { chunk: 250 });
    await this.jobRepo().update(job.id, { totalBytes, totalEntries: entries.length, exclusions, bytes: 0, completedEntries: 0, updated: Date.now() });
    if (exclusions.length) {
      // The caller must explicitly acknowledge exclusions before restarting.
      const same = JSON.stringify(job.exclusions) === JSON.stringify(exclusions);
      if (!same) {
        await this.jobRepo().update(job.id, { state: "paused", errorCode: "FILES_TRANSFER_EXCLUDED" });
        fail("FILES_TRANSFER_EXCLUDED");
      }
    }
    return entries;
  }
  private async prepareDownload(job: FileTransfer): Promise<void> {
    const entries = await this.scan(job);
    const reserve = entries.reduce((total, entry) => total + entry.size + 2048, 4096);
    await this.locked("spool-budget", async () => {
      const others = await this.jobRepo().findBy({ state: In(["ready", "running"]) });
      const used = others.filter((other) => other.id !== job.id).reduce((sum, other) => sum + other.archiveBytes, 0);
      const disk = await statfs(this.spool);
      if (used + reserve > this.spoolBytes || disk.bavail * disk.bsize < reserve + 64 * 1024 ** 2) fail("FILES_TRANSFER_DISK_FULL", 507);
      await this.jobRepo().update(job.id, { archiveBytes: reserve });
    });
    const partial = join(this.spool, job.id + ".partial");
    const zip = new ZipStream({ forceZip64: true, store: true });
    const output = createWriteStream(partial, { flags: "w", mode: 0o600 });
    const done = pipeline(zip, output);
    // Attach immediately so a disk error cannot become an unhandled rejection.
    void done.catch(() => undefined);
    try {
      for (const entry of entries) {
        await this.checkpoint(job);
        const source = entry.kind === "directory" ? null : Readable.from(this.readEntry(job, entry));
        await Promise.race([done, new Promise<void>((resolve, reject) => {
          zip.entry(source, { name: entry.path + (entry.kind === "directory" ? "/" : ""), type: entry.kind, mode: entry.kind === "directory" ? 0o700 : 0o600 },
            (error) => error ? reject(error) : resolve());
        })]);
        await this.jobRepo().increment({ id: job.id }, "completedEntries", 1);
      }
      zip.finalize();
      await done;
      await this.checkpoint(job);
      const size = (await stat(partial)).size;
      if (size > reserve) fail("FILES_TRANSFER_DISK_FULL", 507);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(partial, { highWaterMark: FILE_TRANSFER_CHUNK_BYTES })) {
        await this.checkpoint(job);
        hash.update(chunk as Buffer);
      }
      await this.checkpoint(job);
      await rename(partial, join(this.spool, job.id + ".zip"));
      const published = await this.jobRepo().update({ id: job.id, state: "running" }, { state: "ready", archiveBytes: size, etag: `"${hash.digest("hex")}"`, updated: Date.now() });
      if (!published.affected) {
        await unlink(join(this.spool, job.id + ".zip"));
        fail("FILES_TRANSFER_PAUSED");
      }
    } catch (error) {
      zip.destroy();
      output.destroy();
      await done.catch(() => undefined);
      await unlink(partial).catch(() => undefined);
      await this.jobRepo().update(job.id, { archiveBytes: 0 });
      throw error;
    }
  }
  private async *readEntry(job: FileTransfer, entry: FileTransferEntry): AsyncGenerator<Buffer> {
    for (let offset = 0; offset < entry.size;) {
      await this.checkpoint(job);
      const answer = await this.ask(job, entry, "read", { offset });
      const data = Buffer.from(answer.data, "base64");
      if (answer.offset !== offset || data.length !== Math.min(FILE_TRANSFER_CHUNK_BYTES, entry.size - offset)) fail("FILES_TRANSFER_SOURCE_CHANGED");
      offset += data.length;
      await this.jobRepo().increment({ id: job.id }, "bytes", data.length);
      await this.jobRepo().update(job.id, { currentPath: entry.path, updated: Date.now() });
      yield data;
    }
    // Empty files and modifications after the last chunk are checked too.
    const answer = await this.ask(job, entry, "read", { offset: entry.size });
    if (answer.data !== "") fail("FILES_TRANSFER_SOURCE_CHANGED");
  }
  async download(owner: TransferOwner, id: string, request: Request): Promise<Response> {
    const job = await this.get(owner, id);
    if (job.state !== "ready" || job.direction !== "download") fail("FILES_TRANSFER_NOT_READY");
    const file = Bun.file(join(this.spool, job.id + ".zip"));
    if (!(await file.exists()) || file.size !== job.archiveBytes) fail("FILES_TRANSFER_EXPIRED", 410);
    let start = 0;
    let end = file.size - 1;
    let partial = false;
    const range = request.headers.get("range");
    if (range && (!request.headers.has("if-range") || request.headers.get("if-range") === job.etag)) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.size}` } });
      if (!match[1]) start = Math.max(0, file.size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= file.size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.size}` } });
      partial = true;
    }
    await this.jobRepo().update(id, { updated: Date.now() });
    const filename = (job.selection.length === 1 ? basename(job.selection[0] ?? "files") : "files") + ".zip";
    const headers = new Headers({
      "Content-Type": "application/zip", "Content-Length": String(end - start + 1),
      "Content-Disposition": `attachment; filename="files.zip"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Accept-Ranges": "bytes", ETag: job.etag, "Cache-Control": "private, no-store",
    });
    if (partial) headers.set("Content-Range", `bytes ${start}-${end}/${file.size}`);
    // Bun 1.4 loses a sliced BunFile's offset when Elysia merges response headers
    // by reconstructing Response(body). A bounded stream preserves the requested
    // bytes through those layers without buffering the archive in memory.
    const body = partial
      ? Readable.toWeb(createReadStream(join(this.spool, job.id + ".zip"), { start, end, highWaterMark: 65_536 })) as unknown as ReadableStream<Uint8Array>
      : file;
    return new Response(body, { status: partial ? 206 : 200, headers });
  }
  private async discard(job: FileTransfer): Promise<void> {
    for (const suffix of [".zip", ".partial"]) await unlink(join(this.spool, job.id + suffix)).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
    if (job.direction === "upload") {
      for (const entry of await this.entryRepo().findBy({ transferId: job.id, kind: "file" })) {
        await this.ask(job, entry, "discard");
      }
    }
    await this.entryRepo().delete({ transferId: job.id });
    await this.jobRepo().update(job.id, { archiveBytes: 0 });
  }
  async cleanup(): Promise<void> {
    const abandoned = await this.jobRepo().findBy({ direction: "upload", state: "running", updated: LessThan(Date.now() - 90_000) });
    for (const job of abandoned) {
      if (this.locks.has(job.hostId)) continue;
      await this.jobRepo().update(job.id, { state: "paused", errorCode: "FILES_TRANSFER_TIMEOUT" });
      await this.advance(job.hostId);
    }
    const stale = await this.jobRepo().findBy({ updated: LessThan(Date.now() - FILE_TRANSFER_TTL_MS) });
    for (const job of stale) {
      if (this.workers.has(job.id)) continue;
      if (job.state !== "cancelled") await this.jobRepo().update(job.id, { state: "expired" });
      await this.locked(job.hostId, async () => {
        await this.discard(job);
        await this.jobRepo().delete(job.id);
      }).catch(() => undefined);
    }
  }
}
