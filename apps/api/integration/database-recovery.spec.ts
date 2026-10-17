import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_KEY_HEADER, AGENT_WS_PATH } from "@pdmux/protocol";

const container = process.env.PDMUX_RECOVERY_TEST_CONTAINER;
if (process.env.PDMUX_RECOVERY_TEST_ISOLATED !== "1" || !container?.startsWith("pdmux-recovery-test-")) {
  throw new Error("Run this fixture only through bun run test:database-recovery");
}

const apiDirectory = join(__dirname, "..");
// A well-formed code reaches the database; a malformed one is refused without a query.
const enrollment = JSON.stringify({ code: "pdmxe_ABCDE-FGHJK-MNPQR-STVWX" });
const QUERY_TIMEOUT_MS = 2_000;

function docker(...args: string[]): void {
  const result = Bun.spawnSync(["docker", "--context", "default", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr.toString()}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("No port")));
    });
  });
}

interface Answer {
  status: number;
  code: string | undefined;
  message: string | undefined;
  retryAfter: string | null;
  elapsedMs: number;
}

async function until<T>(label: string, probe: () => Promise<T>, done: (value: T) => boolean, limitMs: number): Promise<T> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
    await Bun.sleep(100);
  }
}

describe("[TC-PDHOST-034] API against a PostgreSQL that stops, pauses and returns", () => {
  it("listens without PostgreSQL, becomes ready when it starts, and answers 503 during outages", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "pdmux-recovery-"));
    const spool = join(scratch, "file-transfers");
    const port = await freePort();
    const env = {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      CACHE_PROVIDER: "memory",
      EVENTS_PROVIDER: "memory",
      JOBS_PROVIDER: "local",
      OBJECT_STORAGE_PROVIDER: "local",
      LOCAL_STORAGE_PATH: join(scratch, "files"),
      FILE_TRANSFER_DIR: spool,
      DB_CONNECT_TIMEOUT_MS: String(QUERY_TIMEOUT_MS),
      DB_QUERY_TIMEOUT_MS: String(QUERY_TIMEOUT_MS),
      LOG_LEVEL: "warn",
    };
    const base = `http://127.0.0.1:${port}`;
    const measured: Record<string, number> = {};

    async function call(path: string, init?: RequestInit): Promise<Answer> {
      const started = performance.now();
      const response = await fetch(base + path, { ...init, signal: AbortSignal.timeout(30_000) });
      const text = await response.text();
      let error: { code?: string; message?: string } = {};
      try {
        error = (JSON.parse(text) as { error?: { code?: string; message?: string } }).error ?? {};
      } catch { /* a non-JSON body has no code */ }
      return {
        status: response.status,
        code: error.code,
        message: error.message,
        retryAfter: response.headers.get("retry-after"),
        elapsedMs: Math.round(performance.now() - started),
      };
    }
    const enroll = (): Promise<Answer> => call("/agent/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: enrollment,
    });
    const upgrade = (): Promise<Answer> => call(AGENT_WS_PATH, {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        [AGENT_KEY_HEADER]: `pdmux_${"A".repeat(43)}`,
      },
    });

    const migrate = Bun.spawnSync([process.execPath, "src/migrate.ts"], { cwd: apiDirectory, env, stdout: "pipe", stderr: "pipe" });
    expect(migrate.exitCode).toBe(0);
    docker("stop", container);

    const spawnedAt = performance.now();
    const api = Bun.spawn([process.execPath, "src/main.ts"], { cwd: apiDirectory, env, stdout: "pipe", stderr: "pipe" });
    let output = "";
    let listeningAt: number | undefined;
    const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        output += decoder.decode(chunk);
        if (listeningAt === undefined && output.includes("API listening")) listeningAt = performance.now();
      }
    };
    void collect(api.stdout);
    void collect(api.stderr);
    let exitCode: number | undefined;
    void api.exited.then((code) => { exitCode = code; });

    try {
      await until("the API to listen", async () => ({ listeningAt, exitCode }),
        (state) => state.listeningAt !== undefined || state.exitCode !== undefined, 20_000);
      expect(exitCode).toBeUndefined();
      measured.listenWithoutDatabaseMs = Math.round((listeningAt ?? 0) - spawnedAt);

      expect((await call("/health")).status).toBe(200);
      const notReady = await call("/health/ready");
      expect(notReady.status).toBe(503);
      expect(notReady.message).toContain("db");
      expect(notReady.message).toContain("pdmux-schema");
      const refused = await enroll();
      expect(refused).toMatchObject({ status: 503, code: "DATABASE_UNAVAILABLE", retryAfter: "1" });
      expect(await upgrade()).toMatchObject({ status: 503, code: "DATABASE_UNAVAILABLE" });
      // The transfer service creates its spool when it starts, after the first connection.
      expect(existsSync(spool)).toBe(false);

      const startedAt = performance.now();
      docker("start", container);
      await until("readiness", () => call("/health/ready"), (answer) => answer.status === 200, 30_000);
      measured.readyAfterStartMs = Math.round(performance.now() - startedAt);
      expect(existsSync(spool)).toBe(true);
      expect((await enroll()).status).toBe(401);
      expect((await upgrade()).status).toBe(401);

      docker("pause", container);
      try {
        const paused = await enroll();
        measured.pausedRequestMs = paused.elapsedMs;
        expect(paused).toMatchObject({ status: 503, code: "DATABASE_UNAVAILABLE", retryAfter: "1" });
        expect(paused.elapsedMs).toBeLessThan(QUERY_TIMEOUT_MS * 2 + 1_000);
        const pausedAgain = await enroll();
        expect(pausedAgain.status).toBe(503);
        expect(pausedAgain.elapsedMs).toBeLessThan(QUERY_TIMEOUT_MS * 2 + 1_000);
      } finally {
        docker("unpause", container);
      }
      const unpausedAt = performance.now();
      await until("recovery after unpause", enroll, (answer) => answer.status === 401, 30_000);
      measured.recoveredAfterUnpauseMs = Math.round(performance.now() - unpausedAt);

      docker("stop", container);
      const stopped = await enroll();
      measured.stoppedRequestMs = stopped.elapsedMs;
      expect(stopped).toMatchObject({ status: 503, code: "DATABASE_UNAVAILABLE", retryAfter: "1" });
      expect(exitCode).toBeUndefined();
      const restartedAt = performance.now();
      docker("start", container);
      await until("recovery after restart", enroll, (answer) => answer.status === 401, 30_000);
      measured.recoveredAfterRestartMs = Math.round(performance.now() - restartedAt);
      await until("readiness after restart", () => call("/health/ready"), (answer) => answer.status === 200, 30_000);

      const stoppingAt = performance.now();
      api.kill("SIGTERM");
      expect(await api.exited).toBe(0);
      measured.shutdownMs = Math.round(performance.now() - stoppingAt);
      console.log(JSON.stringify({ measured }));
    } catch (error: unknown) {
      console.error(output.slice(-4_000));
      throw error;
    } finally {
      if (exitCode === undefined) api.kill("SIGKILL");
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);
});
