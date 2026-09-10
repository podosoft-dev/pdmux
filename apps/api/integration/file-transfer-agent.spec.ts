import { describe, expect, it } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import type { DataSource } from "typeorm";
import { agentUpstreamSchema, fsTransferRequestSchema, type FileTransferManifestEntry, type FsTransferResult } from "@pdmux/protocol";
import { FileTransfersService, type TransferAgent, type TransferOwner } from "../src/file-transfers/file-transfers.service";
import { FileTransfer, FileTransferEntry } from "../src/file-transfers/file-transfer.entity";
import { createAppDataSource } from "../src/database/data-source";
import { BunSqliteDatabaseAdapter } from "../src/database/sqlite-driver";
import { Host } from "../src/hosts/host.entity";
import { AppException } from "../src/common/app-exception";

const executable = process.env.PDMUX_TRANSFER_TEST_AGENT;
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

class AgentBridge implements TransferAgent {
  private child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, { resolve: (result: FsTransferResult) => void; reject: (error: Error) => void }>();
  constructor(executable: string, home: string) {
    this.child = spawn(executable, [home], { stdio: "pipe" });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line): void => {
      const frame = agentUpstreamSchema.parse(JSON.parse(line));
      if (frame.type !== "fsTransferResult") return;
      const pending = this.pending.get(frame.result.requestId);
      this.pending.delete(frame.result.requestId);
      if (frame.result.error) pending?.reject(new AppException(frame.result.error, "Agent rejected transfer", 409));
      else pending?.resolve(frame.result);
    });
    this.child.on("exit", (): void => { for (const pending of this.pending.values()) pending.reject(new Error("Agent exited")); this.pending.clear(); });
  }
  transfer(_scope: string, _hostId: string, input: Parameters<TransferAgent["transfer"]>[2]): Promise<FsTransferResult> {
    const requestId = randomUUID();
    return new Promise((resolve, reject): void => {
      this.pending.set(requestId, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ type: "fsTransfer", transfer: fsTransferRequestSchema.parse({ ...input, requestId }) }) + "\n");
    });
  }
  async close(): Promise<void> { this.child.stdin.end(); await once(this.child, "exit"); }
}

interface TransferFixture { root: string; home: string; agent: AgentBridge; db: DataSource; owner: TransferOwner; service: FileTransfersService }
async function createFixture(): Promise<TransferFixture> {
  if (!executable) throw new Error("Set PDMUX_TRANSFER_TEST_AGENT");
  const root = await mkdtemp(join(tmpdir(), "pdmux-transfer-agent-test-"));
  const home = join(root, "home");
  await mkdir(home);
  const agent = new AgentBridge(executable, home);
  const db = createAppDataSource({ type: "better-sqlite3", driver: BunSqliteDatabaseAdapter,
    database: join(root, "test.sqlite"), entities: [FileTransfer, FileTransferEntry], synchronize: true });
  await db.initialize();
  const owner: TransferOwner = { userId: "test", organizationId: "personal:test", hostId: randomUUID() };
  const service = new FileTransfersService(db, agent, {
    get: async (): Promise<Host> => Object.assign(new Host(), { enabled: true, capabilities: ["files", "files-transfer-v1"] }),
  }, { FILE_TRANSFER_DIR: join(root, "spool") });
  await service.initialize();
  return { root, home, agent, db, owner, service };
}
async function closeFixture(fixture: TransferFixture): Promise<void> {
  await fixture.service.close();
  await fixture.agent.close();
  await fixture.db.destroy();
  await rm(fixture.root, { recursive: true, force: true });
}

describe.skipIf(!executable)("[TC-PDFILE-010] real Go agent file transfers", (): void => {
  it("uploads a thousand-file tree, preserves empty folders and validates the generated ZIP", async (): Promise<void> => {
    const fixture = await createFixture();
    const { root, home, owner, service } = fixture;
    const waitState = async (id: string, wanted: string): Promise<void> => {
      for (let attempt = 0; attempt < 6000; attempt++) {
        const job = await service.get(owner, id);
        if (job.state === wanted) return;
        if (job.state === "failed") throw new Error(job.errorCode);
        await Bun.sleep(5);
      }
      throw new Error("Timed out");
    };
    try {
      const id = randomUUID();
      const entries: FileTransferManifestEntry[] = [
        { id: randomUUID(), path: "folder", kind: "directory", size: 0, fingerprint: "", modified: "" },
        { id: randomUUID(), path: "folder/empty", kind: "directory", size: 0, fingerprint: "", modified: "" },
      ];
      for (let i = 0; i < 1001; i++) entries.push({
        id: randomUUID(), path: `folder/${i}.txt`, kind: "file", size: 7, fingerprint: hash(hash("payload")), modified: "",
      });
      await service.create(owner, { id, direction: "upload", basePath: "", selection: [] });
      for (let i = 0; i < entries.length; i += 250) await service.manifest(owner, id, entries.slice(i, i + 250));
      await service.control(owner, id, "start");
      await waitState(id, "running");
      for (const entry of entries) {
        if (entry.kind === "file") await service.chunk(owner, id, entry.id, 0, hash("payload"), Buffer.from("payload"));
        await service.commit(owner, id, entry.id);
      }
      expect((await service.get(owner, id)).state).toBe("completed");
      expect((await stat(join(home, "folder/empty"))).isDirectory()).toBe(true);
      expect(await readFile(join(home, "folder/1000.txt"), "utf8")).toBe("payload");
      const download = randomUUID();
      await service.create(owner, { id: download, direction: "download", basePath: "", selection: ["folder"] });
      await service.control(owner, download, "start");
      await waitState(download, "ready");
      const response = await service.download(owner, download, new Request("http://localhost/download"));
      const zip = join(root, "result.zip");
      await writeFile(zip, Buffer.from(await response.arrayBuffer()));
      const child = Bun.spawn(["unzip", "-t", zip], { stdout: "pipe", stderr: "pipe" });
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(output).toContain("folder/empty/");
      expect(output).toContain("folder/1000.txt");
      const extracted = Bun.spawn(["unzip", "-p", zip, "folder/1000.txt"], { stdout: "pipe" });
      expect(await new Response(extracted.stdout).text()).toBe("payload");
      expect(await extracted.exited).toBe(0);
    } finally {
      await closeFixture(fixture);
    }
  }, 180_000);

  it.skipIf(process.env.PDMUX_TRANSFER_LARGE_TEST !== "1")("streams a ZIP64 archive beyond 4 GiB with bounded memory", async (): Promise<void> => {
    const fixture = await createFixture();
    const { root, home, owner, service } = fixture;
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sampler = setInterval((): void => { peak = Math.max(peak, process.memoryUsage().rss); }, 100);
    try {
      const handle = await open(join(home, "large.bin"), "w", 0o600);
      await handle.truncate(4 * 1024 ** 3 + 123);
      await handle.close();
      const id = randomUUID();
      await service.create(owner, { id, direction: "download", basePath: "", selection: ["large.bin"] });
      await service.control(owner, id, "start");
      let ready = false;
      for (let attempt = 0; attempt < 5000; attempt++) {
        const job = await service.get(owner, id);
        if (job.state === "ready") { ready = true; break; }
        if (job.state === "failed") throw new Error(job.errorCode);
        await Bun.sleep(100);
      }
      expect(ready).toBe(true);
      const job = await service.get(owner, id);
      expect(job.archiveBytes).toBeGreaterThan(4 * 1024 ** 3);
      const response = await service.download(owner, id, new Request("http://localhost/download", {
        headers: { range: "bytes=-4096", "if-range": job.etag },
      }));
      const tail = Buffer.from(await response.arrayBuffer());
      expect(response.status).toBe(206);
      expect(tail.length).toBe(4096);
      expect(tail.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true);
      const unzip = Bun.spawn(["unzip", "-t", join(root, "spool", id + ".zip")], { stdout: "pipe", stderr: "pipe" });
      const output = await new Response(unzip.stdout).text();
      expect(await unzip.exited).toBe(0);
      expect(output).toContain("No errors detected");
      expect(peak - baseline).toBeLessThan(512 * 1024 ** 2);
      console.log(JSON.stringify({ archiveBytes: job.archiveBytes, baselineRss: baseline, peakRss: peak }));
    } finally {
      clearInterval(sampler);
      await closeFixture(fixture);
    }
  }, 600_000);
});
