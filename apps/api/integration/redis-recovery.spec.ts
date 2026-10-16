import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const container = process.env.PDMUX_REDIS_TEST_CONTAINER;
const image = process.env.PDMUX_REDIS_TEST_IMAGE;
const redisPort = process.env.PDMUX_REDIS_TEST_PORT;
const label = process.env.PDMUX_REDIS_TEST_LABEL;
if (
  process.env.PDMUX_REDIS_TEST_ISOLATED !== "1" || !container?.startsWith("pdmux-redis-recovery-test-") ||
  !image || !redisPort || !label
) {
  throw new Error("Run this fixture only through bun run test:redis-recovery");
}

const apiDirectory = join(__dirname, "..");
const SCHEDULED_QUEUES = ["stale-hosts", "metrics-retention"];

function docker(...args: string[]): string {
  const result = Bun.spawnSync(["docker", "--context", "default", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function redis(...command: string[]): string {
  return docker("exec", container as string, "redis-cli", ...command);
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

async function until<T>(label: string, probe: () => Promise<T> | T, done: (value: T) => boolean, limitMs: number): Promise<T> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
    await Bun.sleep(100);
  }
}

interface Answer {
  status: number;
  code: string | undefined;
  message: string | undefined;
  body: Record<string, unknown>;
  elapsedMs: number;
}

interface Process {
  output: () => string;
  exitCode: () => number | undefined;
  kill: (signal: NodeJS.Signals) => void;
  exited: Promise<number>;
  readyAt: () => number | undefined;
}

function start(entry: string, env: Record<string, string | undefined>, readyLine?: string): Process {
  const child = Bun.spawn([process.execPath, entry], { cwd: apiDirectory, env, stdout: "pipe", stderr: "pipe" });
  let output = "";
  let readyAt: number | undefined;
  let exitCode: number | undefined;
  const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output += decoder.decode(chunk);
      if (readyLine && readyAt === undefined && output.includes(readyLine)) readyAt = performance.now();
    }
  };
  void collect(child.stdout);
  void collect(child.stderr);
  void child.exited.then((code) => { exitCode = code; });
  return {
    output: () => output,
    exitCode: () => exitCode,
    kill: (signal) => child.kill(signal),
    exited: child.exited,
    readyAt: () => readyAt,
  };
}

/** The repeat entries BullMQ keeps per scheduled queue; each must exist exactly once. */
function scheduledRepeats(): number[] {
  return SCHEDULED_QUEUES.map((queue) => Number(redis("ZCARD", `bull:${queue}:repeat`)));
}

function replaceRedisWithAnEmptyOne(): void {
  docker("rm", "--force", container as string);
  docker("create", "--name", container as string, "--label", label as string,
    "--publish", `127.0.0.1:${redisPort}:6379`, image as string);
}

describe("[TC-PDHOST-036][TC-PDWEB-039] API and worker against a Redis that is down, then replaced", () => {
  it("listens without Redis, schedules maintenance once it starts, fails enqueues fast, and resyncs the fleet stream", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "pdmux-redis-recovery-"));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    // Production requires an HTTPS auth origin; requests carry it as their Origin.
    const origin = "https://localhost";
    const email = "redis-recovery@example.com";
    const env = {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      BETTER_AUTH_URL: origin,
      CORS_ORIGIN: origin,
      ADMIN_EMAILS: email,
      AUTH_REQUIRE_SIGNUP_APPROVAL: "false",
      AUTH_HIBP_ENABLED: "false",
      PDMUX_CACHE_PROVIDER: "memory",
      PDMUX_EVENTS_PROVIDER: "redis",
      PDMUX_JOBS_PROVIDER: "bullmq",
      PDMUX_OBJECT_STORAGE_PROVIDER: "local",
      LOCAL_STORAGE_PATH: join(scratch, "files"),
      FILE_TRANSFER_DIR: join(scratch, "file-transfers"),
      // Each readiness probe below must see the current state, not a cached one.
      READINESS_CACHE_MS: "0",
      LOG_LEVEL: "info",
    };
    const measured: Record<string, number> = {};
    let cookie = "";

    async function call(path: string, init: RequestInit = {}): Promise<Answer> {
      const started = performance.now();
      const response = await fetch(base + path, {
        ...init,
        headers: { origin, ...(cookie ? { cookie } : {}), ...init.headers },
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* a non-JSON body has no fields */ }
      const error = (body.error ?? {}) as { code?: string; message?: string };
      if (response.headers.getSetCookie().length > 0) {
        cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
      }
      return { status: response.status, code: error.code, message: error.message, body, elapsedMs: Math.round(performance.now() - started) };
    }
    const enqueue = (text: string): Promise<Answer> => call("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    async function completes(text: string): Promise<number> {
      const started = performance.now();
      const created = await until(`enqueue ${text}`, () => enqueue(text), (answer) => answer.status === 201, 30_000);
      const id = String(created.body.id);
      await until(`job ${text}`, () => call(`/jobs/${encodeURIComponent(id)}`), (answer) => answer.body.state === "completed", 30_000);
      return Math.round(performance.now() - started);
    }

    /** Collects the fleet stream's frames, as the dashboard's EventSource receives them. */
    async function openFleetStream(signal: AbortSignal): Promise<() => string[]> {
      const response = await fetch(`${base}/fleet/events`, { headers: { origin, cookie }, signal });
      expect(response.status).toBe(200);
      let text = "";
      void (async (): Promise<void> => {
        const decoder = new TextDecoder();
        try {
          for await (const chunk of response.body as ReadableStream<Uint8Array>) text += decoder.decode(chunk);
        } catch { /* aborted at the end of the test */ }
      })();
      return () => text.split("\n\n").filter((frame) => frame.startsWith("data: ")).map((frame) => frame.slice(6));
    }
    const resyncs = (frames: () => string[]): number => frames().filter((frame) => frame === '{"type":"resync"}').length;

    const migrate = Bun.spawnSync([process.execPath, "src/migrate.ts"], { cwd: apiDirectory, env, stdout: "pipe", stderr: "pipe" });
    expect(migrate.exitCode, migrate.stderr.toString().slice(-2_000)).toBe(0);

    const spawnedAt = performance.now();
    const api = start("src/main.ts", env, "API listening");
    let worker: Process | undefined;
    const closeStream = new AbortController();
    try {
      await until("the API to listen", () => ({ listening: api.readyAt() !== undefined, exitCode: api.exitCode() }),
        (state) => state.listening || state.exitCode !== undefined, 20_000);
      expect(api.exitCode()).toBeUndefined();
      measured.listenWithoutRedisMs = Math.round((api.readyAt() ?? 0) - spawnedAt);

      expect((await call("/health")).status).toBe(200);
      const notReady = await call("/health/ready");
      expect(notReady.status).toBe(503);
      for (const check of ["jobs", "pdmux-maintenance", "events"]) expect(notReady.message).toContain(check);
      expect(api.output()).toContain('"dependency":"pdmux-maintenance"');

      const signedUp = await call("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Redis Recovery", email, password: `${crypto.randomUUID()}!Az9` }),
      });
      expect(signedUp.status).toBe(200);
      const refused = await enqueue("during the first outage");
      measured.enqueueWithoutRedisMs = refused.elapsedMs;
      expect(refused).toMatchObject({ status: 503, code: "JOBS_UNAVAILABLE" });
      expect(refused.elapsedMs).toBeLessThan(1_000);
      const frames = await openFleetStream(closeStream.signal);
      await until("the fleet stream", frames, (received) => received.includes('{"type":"ready"}'), 5_000);
      expect(resyncs(frames)).toBe(0);

      const startedAt = performance.now();
      docker("start", container);
      await until("readiness", () => call("/health/ready"), (answer) => answer.status === 200, 30_000);
      measured.readyAfterRedisStartMs = Math.round(performance.now() - startedAt);
      expect(scheduledRepeats()).toEqual([1, 1]);
      // Host notices published before the bus connected were lost, so the open stream resyncs.
      await until("a resync after Redis started", () => resyncs(frames), (count) => count === 1, 5_000);

      worker = start("src/main-worker.ts", env);
      measured.jobCompletedMs = await completes("before the restart");

      replaceRedisWithAnEmptyOne();
      const duringRestart = await enqueue("while Redis is replaced");
      measured.enqueueDuringRestartMs = duringRestart.elapsedMs;
      expect(duringRestart).toMatchObject({ status: 503, code: "JOBS_UNAVAILABLE" });
      expect(duringRestart.elapsedMs).toBeLessThan(1_000);
      expect((await call("/health/ready")).status).toBe(503);

      const restartedAt = performance.now();
      docker("start", container);
      await until("readiness after the restart", () => call("/health/ready"), (answer) => answer.status === 200, 30_000);
      measured.readyAfterRestartMs = Math.round(performance.now() - restartedAt);
      // The new Redis started empty, so these were applied again on reconnect.
      expect(scheduledRepeats()).toEqual([1, 1]);
      await until("a resync after Redis was replaced", () => resyncs(frames), (count) => count === 2, 5_000);
      measured.jobAfterRestartMs = await completes("after the restart");
      expect(api.exitCode()).toBeUndefined();
      expect(worker.exitCode()).toBeUndefined();

      closeStream.abort();
      const stoppingAt = performance.now();
      api.kill("SIGTERM");
      worker.kill("SIGTERM");
      expect(await api.exited).toBe(0);
      expect(await worker.exited).toBe(0);
      measured.shutdownMs = Math.round(performance.now() - stoppingAt);
      console.log(JSON.stringify({ measured }));
    } catch (error: unknown) {
      console.error(api.output().slice(-6_000));
      if (worker) console.error(worker.output().slice(-3_000));
      throw error;
    } finally {
      closeStream.abort();
      if (api.exitCode() === undefined) api.kill("SIGKILL");
      if (worker && worker.exitCode() === undefined) worker.kill("SIGKILL");
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});
