import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { DataSource } from "typeorm";
import { fsTransferRequestSchema, fsTransferResultSchema, type FsTransferEntry, type FsTransferRequest } from "@pdmux/protocol";
import { FileTransfersService, type TransferAgent, type TransferOwner } from "./file-transfers.service";
import { FileTransfer, FileTransferEntry } from "./file-transfer.entity";
import { createAppDataSource } from "../database/data-source";
import { BunSqliteDatabaseAdapter } from "../database/sqlite-driver";
import { Host } from "../hosts/host.entity";
import { AppException } from "../common/app-exception";

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const owner: TransferOwner = { userId: "user", organizationId: "personal:user", hostId: "11111111-1111-4111-8111-111111111111" };
const fixtures: Array<{ root: string; db: DataSource; service: FileTransfersService }> = [];

async function fixture(env: NodeJS.ProcessEnv = {}, beforeTransfer?: (request: FsTransferRequest) => Promise<void>): Promise<{ db: DataSource; service: FileTransfersService; root: string; files: Map<string, FsTransferEntry> }> {
  const root = await mkdtemp(join(tmpdir(), "pdmux-transfer-test-"));
  const db = createAppDataSource({
    type: "better-sqlite3", driver: BunSqliteDatabaseAdapter, database: join(root, "test.sqlite"),
    entities: [FileTransfer, FileTransferEntry], synchronize: true,
  });
  await db.initialize();
  const stages = new Map<string, { offset: number; committed: boolean }>();
  const files = new Map<string, FsTransferEntry>([
    ["folder", { path: "folder", kind: "directory", size: 0, modified: "stamp" }],
    ["folder/empty", { path: "folder/empty", kind: "directory", size: 0, modified: "stamp" }],
    ["folder/file.txt", { path: "folder/file.txt", kind: "file", size: 7, modified: "stamp" }],
  ]);
  const agent: TransferAgent = {
    async transfer(_scope, _hostId, input) {
      const req = fsTransferRequestSchema.parse({ ...input, requestId: randomUUID() });
      await beforeTransfer?.(req);
      const result = fsTransferResultSchema.parse(req);
      const stage = stages.get(req.entryId) ?? { offset: 0, committed: false };
      switch (req.action) {
        case "stat":
          result.entries = [files.get(req.path) ?? { path: req.path, kind: "missing", size: 0, modified: "" }];
          break;
        case "list":
          result.entries = [...files.values()].filter((file) => file.path.startsWith(req.path + "/") && !file.path.slice(req.path.length + 1).includes("/"));
          break;
        case "read":
          result.data = Buffer.from("payload").subarray(req.offset).toString("base64");
          result.offset = req.offset;
          return result;
        case "write":
          stage.offset = Math.max(stage.offset, req.offset + Buffer.from(req.data, "base64").length);
          stages.set(req.entryId, stage);
          break;
        case "commit":
        case "mkdir":
          stage.committed = true;
          stages.set(req.entryId, stage);
          break;
        case "discard":
          stages.delete(req.entryId);
          break;
        case "touch": break;
      }
      result.offset = stage.offset;
      result.committed = stage.committed;
      return result;
    },
  };
  const service = new FileTransfersService(db, agent, {
    async get(scope, id): Promise<Host> {
      if (scope !== owner.organizationId || id !== owner.hostId) throw new AppException("HOST_NOT_FOUND", "Unknown host", 404);
      return Object.assign(new Host(), { id, enabled: true, capabilities: ["files", "files-transfer-v1"] });
    },
  }, { FILE_TRANSFER_DIR: join(root, "spool"), ...env });
  fixtures.push({ root, db, service });
  await service.initialize();
  return { db, service, root, files };
}

afterEach(async (): Promise<void> => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.service.close();
    if (fixture.db.isInitialized) await fixture.db.destroy();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function waitState(service: FileTransfersService, id: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await service.get(owner, id);
    if (state.state === expected) return;
    if (state.state === "failed") throw new Error(state.errorCode);
    await Bun.sleep(5);
  }
  throw new Error("Transfer did not reach " + expected);
}

describe("[TC-PDFILE-004] durable scoped transfers", (): void => {
  it("isolates users/scopes and accepts duplicate manifests without advancing twice", async (): Promise<void> => {
    const { service } = await fixture();
    const id = randomUUID();
    await service.create(owner, { id, direction: "upload", basePath: "", selection: [] });
    await expect(service.get({ ...owner, userId: "other" }, id)).rejects.toMatchObject({ code: "FILES_TRANSFER_NOT_FOUND" });
    await expect(service.get({ ...owner, organizationId: "other" }, id)).rejects.toMatchObject({ code: "HOST_NOT_FOUND" });
    const entry = { id: randomUUID(), path: "new.txt", size: 7, kind: "file" as const, fingerprint: hash(hash("payload")), modified: "" };
    await service.manifest(owner, id, [entry]);
    await service.manifest(owner, id, [entry]);
    expect((await service.get(owner, id)).totalEntries).toBe(1);
    await service.control(owner, id, "start");
    await waitState(service, id, "running");
    await service.chunk(owner, id, entry.id, 0, hash("payload"), Buffer.from("payload"));
    await service.chunk(owner, id, entry.id, 0, hash("payload"), Buffer.from("payload"));
    expect((await service.get(owner, id)).bytes).toBe(7);
    await service.commit(owner, id, entry.id);
    expect((await service.get(owner, id)).state).toBe("completed");
  });
  it("rejects path traversal and detects conflicts before writing", async (): Promise<void> => {
    const { service } = await fixture();
    const id = randomUUID();
    await service.create(owner, { id, direction: "upload", basePath: "", selection: [] });
    const entry = { id: randomUUID(), path: "../outside", size: 7, kind: "file" as const, fingerprint: hash(hash("payload")), modified: "" };
    await expect(service.manifest(owner, id, [entry])).rejects.toMatchObject({ code: "FILES_TRANSFER_PATH" });
    entry.path = "folder/file.txt";
    await service.manifest(owner, id, [entry]);
    await service.control(owner, id, "start");
    await waitState(service, id, "running");
    await expect(service.chunk(owner, id, entry.id, 0, hash("payload"), Buffer.from("payload"))).rejects.toMatchObject({ code: "FILES_TRANSFER_CONFLICT" });
    await service.decide(owner, id, entry.id, "skip");
    expect((await service.get(owner, id)).completedEntries).toBe(1);
    expect((await service.get(owner, id)).bytes).toBe(0);
  });
});

describe("[TC-PDFILE-005] immutable ZIP downloads", (): void => {
  it("queues another job promptly during a slow ZIP and discards cancelled partial output", async (): Promise<void> => {
    let release: () => void = (): void => {};
    let reading: () => void = (): void => {};
    const blocked = new Promise<void>((resolve): void => { release = resolve; });
    const started = new Promise<void>((resolve): void => { reading = resolve; });
    const { service, root } = await fixture({}, async (req): Promise<void> => {
      if (req.action === "read" && req.offset === 0) { reading(); await blocked; }
    });
    const id = randomUUID();
    try {
      await service.create(owner, { id, direction: "download", basePath: "", selection: ["folder"] });
      await service.control(owner, id, "start");
      await started;
      const upload = await Promise.race([
        service.create(owner, { id: randomUUID(), direction: "upload", basePath: "", selection: [] }),
        Bun.sleep(500).then((): never => { throw new Error("Metadata blocked behind ZIP worker"); }),
      ]);
      await service.manifest(owner, upload.id, [{ id: randomUUID(), path: "empty", kind: "directory", size: 0, fingerprint: "", modified: "" }]);
      await service.control(owner, upload.id, "start");
      expect((await service.get(owner, upload.id)).state).toBe("queued");
      await service.control(owner, id, "cancel");
      release();
      await waitState(service, upload.id, "running");
      expect((await service.get(owner, id)).state).toBe("cancelled");
      expect(await readdir(join(root, "spool"))).toEqual([]);
    } finally { release(); }
  });
  it("requires exclusion review, enforces spool quotas, and removes expired ZIPs", async (): Promise<void> => {
    const { service, db, root, files } = await fixture();
    files.set("folder/link", { path: "folder/link", kind: "link", size: 0, modified: "stamp" });
    const id = randomUUID();
    await service.create(owner, { id, direction: "download", basePath: "", selection: ["folder"] });
    await service.control(owner, id, "start");
    await waitState(service, id, "paused");
    expect((await service.get(owner, id)).exclusions).toEqual(["folder/link"]);
    await service.control(owner, id, "start");
    await waitState(service, id, "ready");
    expect(await readdir(join(root, "spool"))).toContain(id + ".zip");
    await db.getRepository(FileTransfer).update(id, { updated: Date.now() - 25 * 60 * 60 * 1000 });
    await service.cleanup();
    expect(await readdir(join(root, "spool"))).toEqual([]);
    expect(await db.getRepository(FileTransferEntry).countBy({ transferId: id })).toBe(0);
    await expect(service.get(owner, id)).rejects.toMatchObject({ code: "FILES_TRANSFER_NOT_FOUND" });
    const limited = await fixture({ FILE_TRANSFER_SPOOL_BYTES: "1" });
    const other = randomUUID();
    await limited.service.create(owner, { id: other, direction: "download", basePath: "", selection: ["folder"] });
    await limited.service.control(owner, other, "start");
    await waitState(limited.service, other, "failed");
    expect((await limited.service.get(owner, other)).errorCode).toBe("FILES_TRANSFER_DISK_FULL");
    expect(await readdir(join(limited.root, "spool"))).toEqual([]);
  });
  it("preserves empty directories and serves stable Range/If-Range responses", async (): Promise<void> => {
    const { service } = await fixture();
    const id = randomUUID();
    await service.create(owner, { id, direction: "download", basePath: "", selection: ["folder"] });
    await service.control(owner, id, "start");
    await waitState(service, id, "ready");
    const request = new Request("http://localhost/download");
    const full = await service.download(owner, id, request);
    const bytes = Buffer.from(await full.arrayBuffer());
    expect(bytes.includes(Buffer.from("folder/empty/"))).toBe(true);
    expect(bytes.includes(Buffer.from("payload"))).toBe(true);
    expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true);
    const ranged = await service.download(owner, id, new Request(request, { headers: { range: "bytes=10-99", "if-range": full.headers.get("etag") ?? "" } }));
    expect(ranged.status).toBe(206);
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(bytes.subarray(10, 100));
    expect(ranged.headers.get("etag")).toBe(full.headers.get("etag"));
    const changed = await service.download(owner, id, new Request(request, { headers: { range: "bytes=10-", "if-range": '"old"' } }));
    expect(changed.status).toBe(200);
    const invalid = await service.download(owner, id, new Request(request, { headers: { range: "bytes=999999-" } }));
    expect(invalid.status).toBe(416);
  });
});

describe("[TC-PDFILE-006] SQLite restart recovery", (): void => {
  it("adds transfer tables to an older SQLite database without changing existing rows", async (): Promise<void> => {
    const { db, service } = await fixture();
    await service.close();
    await db.query('CREATE TABLE legacy_data (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    await db.query("INSERT INTO legacy_data VALUES ('kept', 'original')");
    await db.query('DROP TABLE file_transfer_entries');
    await db.query('DROP TABLE file_transfers');
    await db.destroy();
    await db.initialize();
    await service.initialize();
    const preserved: unknown = await db.query('SELECT * FROM legacy_data');
    expect(preserved).toEqual([{ id: "kept", payload: "original" }]);
    const job = await service.create(owner, { id: randomUUID(), direction: "upload", basePath: "", selection: [] });
    expect(job.state).toBe("draft");
  });
  it("retains rows and pauses interrupted uploads on initialization", async (): Promise<void> => {
    const { db, service, root } = await fixture();
    const id = randomUUID();
    await service.create(owner, { id, direction: "upload", basePath: "", selection: [] });
    await db.getRepository(FileTransfer).update(id, { state: "running", bytes: 123 });
    await service.close();
    await writeFile(join(root, "spool", id + ".partial"), "unfinished");
    await db.destroy();
    await db.initialize();
    await service.initialize();
    const restored = await service.get(owner, id);
    expect(restored.state).toBe("paused");
    expect(restored.bytes).toBe(123);
    expect(await readdir(join(root, "spool"))).toEqual([]);
  });
});
