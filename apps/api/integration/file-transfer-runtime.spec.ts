import { describe, expect, it } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Elysia } from "elysia";
import { agentConfigSchema, type AgentHello, type FileTransferEntryView, type FileTransferManifestEntry, type FileTransferView } from "@pdmux/protocol";
import { AppException } from "../src/common/app-exception";
import { createAppDataSource } from "../src/database/data-source";
import { BunSqliteDatabaseAdapter } from "../src/database/sqlite-driver";
import { FileTransfer, FileTransferEntry } from "../src/file-transfers/file-transfer.entity";
import { FileTransfersService } from "../src/file-transfers/file-transfers.service";
import { AgentFilesService } from "../src/agents/agent-files.service";
import { AgentIngestService } from "../src/agents/agent-ingest.service";
import { AgentRegistryService } from "../src/agents/agent-registry.service";
import { Host } from "../src/hosts/host.entity";
import type { HostsService } from "../src/hosts/hosts.service";
import type { AuthSession } from "../src/auth/auth.service";
import { ServiceRegistry, type AppContext } from "../src/core/services";
import { PDMUX, type PdmuxServices } from "../src/pdmux/pdmux.services";
import { pdmuxHttpPlugin } from "../src/pdmux/pdmux.http";
import { PdmuxGateway } from "../src/pdmux/pdmux.gateway";
import { createPdmuxWsPlugin } from "../src/pdmux/pdmux.ws";

const executable = process.env.PDMUX_TRANSFER_RUNTIME_AGENT;
const hash = (input: string | Uint8Array): string => createHash("sha256").update(input).digest("hex");
const chunkBytes = 1_048_576;

async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(25);
  }
}

// Authentication, host metadata and metrics are fixture dependencies. HTTP routes,
// gateway, registry, ingest, transfer services, SQLite and the entire Go daemon are real.
describe.skipIf(!executable)("[TC-PDFILE-010] local HTTP and Go WebSocket runtime", (): void => {
  it("resumes durable uploads after daemon/service restart and downloads the verified tree", async (): Promise<void> => {
    if (!executable) throw new Error("Set PDMUX_TRANSFER_RUNTIME_AGENT to a static Linux agent binary");
    const root = await mkdtemp(join(tmpdir(), "pdmux-transfer-runtime-"));
    const home = join(root, "agent-home");
    const container = `pdmux-transfer-test-${randomUUID()}`;
    const owner = { userId: "test", organizationId: "personal:test", hostId: randomUUID() };
    const host: Host = Object.assign(new Host(), { id: owner.hostId, organizationId: owner.organizationId, enabled: true, capabilities: [] });
    let helloCount = 0;
    let heartbeatCount = 0;
    let responseCount = 0;
    const hosts = {
      get: async (scope: string, id: string): Promise<Host> => {
        if (scope !== owner.organizationId || id !== host.id) throw new AppException("HOST_NOT_FOUND", "Unknown host", 404);
        return host;
      },
      getById: async (id: string): Promise<Host | null> => id === host.id ? host : null,
      applyHello: async (_id: string, hello: AgentHello): Promise<void> => { host.capabilities = hello.capabilities; helloCount++; },
      applyHeartbeat: async (): Promise<void> => { heartbeatCount++; },
      touch: async (): Promise<void> => {},
    } as unknown as HostsService;
    const db = createAppDataSource({ type: "better-sqlite3", driver: BunSqliteDatabaseAdapter,
      database: join(root, "test.sqlite"), entities: [FileTransfer, FileTransferEntry], synchronize: true });
    await mkdir(home, { mode: 0o700 });
    await db.initialize();
    const registry = new AgentRegistryService();
    const files = new AgentFilesService(registry, hosts);
    const deps: ConstructorParameters<typeof AgentIngestService> = [
      hosts,
      { recordHeartbeat: async (): Promise<null> => null } as unknown as ConstructorParameters<typeof AgentIngestService>[1],
      {} as ConstructorParameters<typeof AgentIngestService>[2],
      { resolve: async (): Promise<{ metricStepSec: number }> => ({ metricStepSec: 10 }) } as unknown as ConstructorParameters<typeof AgentIngestService>[3],
      { publish: (): void => {} } as unknown as ConstructorParameters<typeof AgentIngestService>[4],
      registry,
      {} as ConstructorParameters<typeof AgentIngestService>[6],
      {} as ConstructorParameters<typeof AgentIngestService>[7],
      files,
    ];
    const ingest = new AgentIngestService(...deps);
    const session: AuthSession = { user: { id: owner.userId, role: "admin", name: "Test", email: "test@example.com" }, session: {} };
    const credential = randomUUID();
    const runtimeEnv = { FILE_TRANSFER_DIR: join(root, "spool") };
    let transfers = new FileTransfersService(db, files, hosts, runtimeEnv);
    await transfers.initialize();
    const services = {
      hosts, agentRegistry: registry, agentFiles: files, fileTransfers: transfers,
      auth: { requireSession: async (request: Request): Promise<AuthSession> => {
        if (request.headers.get("cookie") !== "transfer-fixture=1") throw new AppException("UNAUTHORIZED", "No fixture session", 401);
        return session;
      } },
      audit: { recordRequest: async (): Promise<void> => {} },
      agentTokens: {
        resolveOrReason: async (key: string): Promise<unknown> => key === credential
          ? { hostId: host.id, token: { id: "fixture", expiresAt: null } } : { refusal: "invalid_key", hostId: null },
        markUsed: async (): Promise<void> => {},
      },
      agentConfig: { build: async (): Promise<ReturnType<typeof agentConfigSchema.parse>> => agentConfigSchema.parse({ heartbeatSec: 1 }) },
      agentAck: { ackAllRepos: async (): Promise<void> => {} },
      agentIngest: { handle: async (hostId: string, raw: unknown): Promise<unknown> => {
        const result = await ingest.handle(hostId, raw);
        if (!result.ok) throw new Error(result.error);
        if (result.type === "fsTransferResult") responseCount++;
        return result;
      } },
    } as unknown as PdmuxServices;
    const serviceRegistry = new ServiceRegistry();
    serviceRegistry.register(PDMUX, services);
    const context = { services: serviceRegistry } as AppContext;
    const gateway = new PdmuxGateway(services);
    const app = new Elysia().onError(({ error, set }) => {
      if (error instanceof AppException) { set.status = error.statusCode; return { error: { code: error.code } }; }
      return undefined;
    }).use(pdmuxHttpPlugin(context)).use(createPdmuxWsPlugin(gateway)(context))
      .listen({ hostname: "127.0.0.1", port: 0 });
    gateway.start();
    const origin = `http://127.0.0.1:${app.server?.port}`;
    const base = `${origin}/hosts/${host.id}/file-transfers`;
    let daemon: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
    const stopAgent = async (): Promise<void> => {
      if (!daemon) return;
      const stop = Bun.spawn(["docker", "stop", "--time", "2", container], { stdout: "ignore", stderr: "ignore" });
      await stop.exited;
      await daemon.exited;
      daemon = undefined;
    };
    const startAgent = async (): Promise<void> => {
      const before = helloCount;
      daemon = Bun.spawn(["docker", "run", "--rm", "--name", container, "--network", "host", "--read-only",
        "--user", "pdmux", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--tmpfs", "/tmp", "-v", `${home}:/root`, "-v", `${resolve(executable)}:/transfer-agent:ro`,
        `${container}:fixture`, "/transfer-agent", "run", "--config", "/root/agent.json"],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
      await until(async (): Promise<boolean> => {
        if (daemon?.exitCode !== null && daemon?.exitCode !== undefined) {
          throw new Error(`Agent exited: ${await new Response(daemon.stderr).text()}`);
        }
        return helloCount > before && registry.isConnected(host.id);
      }, "real agent hello");
    };
    const request = (path: string, method = "GET", body?: unknown, headers?: Record<string, string>): Promise<Response> => fetch(base + path, {
      method, headers: { cookie: "transfer-fixture=1", ...(body instanceof Uint8Array ? { "content-type": "application/octet-stream" } : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: body instanceof Uint8Array ? new Uint8Array(body) : JSON.stringify(body) }),
    });
    const json = async <T>(path: string, method = "GET", body?: unknown, headers?: Record<string, string>): Promise<T> => {
      const response = await request(path, method, body, headers);
      const text = await response.text();
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
      return JSON.parse(text) as T;
    };
    const state = (id: string, wanted: string): Promise<void> => until(async (): Promise<boolean> => {
      const job = await json<FileTransferView>(`/${id}`);
      if (job.state === "failed") throw new Error(job.errorCode);
      return job.state === wanted;
    }, wanted);
    try {
      // Docker resolves users before bind mounts (moby/moby#39261). Bake this
      // disposable user into the fixture image; do not alter the caller's HOME.
      await writeFile(join(root, "passwd"), `pdmux:x:${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}:Transfer fixture:/root:/bin/sh\n`);
      await writeFile(join(root, "Dockerfile"), "FROM golang:1.26.5\nCOPY passwd /etc/passwd\nUSER pdmux\n");
      const build = Bun.spawn(["docker", "build", "--quiet", "--tag", `${container}:fixture`, root], { stdout: "ignore", stderr: "pipe" });
      const buildErrors = await new Response(build.stderr).text();
      if (await build.exited !== 0) throw new Error(buildErrors);
      await writeFile(join(home, "agent.json"), JSON.stringify({ server: origin, token: credential, hostname: "transfer-test", logLevel: "error" }), { mode: 0o600 });
      await startAgent();
      expect(host.capabilities).toContain("files-transfer-v1");
      expect((await fetch(base)).status).toBe(401);
      const payload = Buffer.alloc(2 * chunkBytes + 17, 0x41);
      const parts = [payload.subarray(0, chunkBytes), payload.subarray(chunkBytes, 2 * chunkBytes), payload.subarray(2 * chunkBytes)];
      const entries: FileTransferManifestEntry[] = [
        { id: randomUUID(), path: "folder", kind: "directory", size: 0, fingerprint: "", modified: "" },
        { id: randomUUID(), path: "folder/empty", kind: "directory", size: 0, fingerprint: "", modified: "" },
        { id: randomUUID(), path: "folder/resume.txt", kind: "file", size: payload.length, fingerprint: hash(parts.map(hash).join("")), modified: "" },
      ];
      const file = entries[2]!;
      await mkdir(join(home, "destination/folder"), { recursive: true });
      await writeFile(join(home, "destination/folder/resume.txt"), "original");
      const id = randomUUID();
      await json("", "POST", { id, direction: "upload", basePath: "destination", selection: [] });
      await json(`/${id}/manifest`, "POST", { entries });
      await json(`/${id}/control`, "POST", { action: "start" });
      await state(id, "running");
      for (const entry of entries.slice(0, 2)) await json(`/${id}/entries/${entry.id}/commit`, "POST");
      const chunkPath = `/${id}/entries/${file.id}/chunk`;
      const send = (offset: number, part: Uint8Array): Promise<Response> => request(chunkPath, "PUT", part, { "x-transfer-offset": String(offset), "x-transfer-sha256": hash(part) });
      const conflict = await send(0, parts[0]!);
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ error: { code: "FILES_TRANSFER_CONFLICT" } });
      await json(`/${id}/entries/${file.id}/decision`, "POST", { action: "replace" });
      expect((await send(0, parts[0]!)).status).toBe(200);
      const progress = await json<FileTransferView>(`/${id}`);
      expect(progress.bytes).toBe(chunkBytes);
      expect(progress.totalBytes).toBe(payload.length);
      expect(progress.completedEntries).toBe(2);
      expect(await readFile(join(home, "destination/folder/resume.txt"), "utf8")).toBe("original");
      await json(`/${id}/control`, "POST", { action: "pause" });
      await state(id, "paused");
      await stopAgent();
      await transfers.close();
      transfers = new FileTransfersService(db, files, hosts, runtimeEnv);
      services.fileTransfers = transfers;
      await transfers.initialize();
      await startAgent();
      await json(`/${id}/control`, "POST", { action: "start" });
      await state(id, "running");
      expect((await json<FileTransferEntryView>(`/${id}/entries/${file.id}/reconcile`, "POST")).offset).toBe(chunkBytes);
      expect((await send(chunkBytes, parts[1]!)).status).toBe(200);
      expect((await send(2 * chunkBytes, parts[2]!)).status).toBe(200);
      await json(`/${id}/entries/${file.id}/commit`, "POST");
      await state(id, "completed");
      expect(hash(await readFile(join(home, "destination/folder/resume.txt")))).toBe(hash(payload));
      expect((await stat(join(home, "destination/folder/empty"))).isDirectory()).toBe(true);
      const downloadId = randomUUID();
      await json("", "POST", { id: downloadId, direction: "download", basePath: "destination", selection: ["folder"] });
      await json(`/${downloadId}/control`, "POST", { action: "start" });
      await state(downloadId, "ready");
      const download = await request(`/${downloadId}/download`);
      expect(download.status).toBe(200);
      expect(download.headers.get("content-type")).toContain("application/zip");
      const archive = Buffer.from(await download.arrayBuffer());
      const zipPath = join(root, "result.zip");
      await writeFile(zipPath, archive);
      const unzip = Bun.spawn(["unzip", "-t", zipPath], { stdout: "pipe", stderr: "pipe" });
      const listing = await new Response(unzip.stdout).text();
      expect(await unzip.exited).toBe(0);
      expect(listing).toContain("folder/empty/");
      const extracted = Bun.spawn(["unzip", "-p", zipPath, "folder/resume.txt"], { stdout: "pipe" });
      expect(hash(new Uint8Array(await new Response(extracted.stdout).arrayBuffer()))).toBe(hash(payload));
      expect(await extracted.exited).toBe(0);
      const range = await request(`/${downloadId}/download`, "GET", undefined, { range: "bytes=23-", "if-range": download.headers.get("etag")! });
      expect(range.status).toBe(206);
      expect(Buffer.from(await range.arrayBuffer())).toEqual(archive.subarray(23));
      await json(`/${downloadId}/control`, "POST", { action: "cancel" });
      expect(await readdir(join(root, "spool"))).toEqual([]);
      expect(hash(await readFile(join(home, "destination/folder/resume.txt")))).toBe(hash(payload));
      await until((): boolean => heartbeatCount > 0, "agent heartbeat");
      expect(helloCount).toBe(2);
      expect(responseCount).toBeGreaterThan(10);
      console.log(JSON.stringify({ helloCount, heartbeatCount, responseCount, uploadedBytes: payload.length, archiveBytes: archive.length }));
    } finally {
      await transfers.close();
      await stopAgent();
      gateway.close();
      await app.stop(true);
      await db.destroy();
      const removeImage = Bun.spawn(["docker", "image", "rm", `${container}:fixture`], { stdout: "ignore", stderr: "ignore" });
      await removeImage.exited;
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
