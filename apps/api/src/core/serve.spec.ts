import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

// An API served by serveApi, as main.ts serves the app, with routes that hold a
// request, a stream that ends at shutdown, one that does not, and a WebSocket.
const FIXTURE = `
import { SQL } from "bun";
import { Elysia } from "elysia";
import { validateEnv } from "../../config/env.validation";
import { PROVIDERS } from "../../config/providers";
import { Database } from "../../database/database";
import { serveApi } from "../serve";
import { createCoreServices, DATABASE, SHUTDOWN } from "../services";
import { GOING_AWAY } from "../shutdown";

// The provider's own URL, though the database it opens is an in-memory SQLite one.
const env = validateEnv({
  ...process.env,
  DATABASE_URL: PROVIDERS.database === "sqlite" ? "sqlite://:memory:" : "postgres://podokit@localhost:5432/podokit",
});
const services = createCoreServices(env);
const database = new Database(env, new SQL(":memory:", { adapter: "sqlite" }));
services.override(DATABASE, database, () => database.close());
const shutdown = services.resolve(SHUTDOWN);
const encoder = new TextEncoder();
const sockets = new Map<string, () => void>();

function eventStream(request: Request, endAtShutdown: boolean): Response {
  let release = (): void => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(encoder.encode("retry: 1000\\n\\n"));
      if (!endAtShutdown) return;
      const end = (): void => {
        release();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      release = shutdown.onShutdown(end);
      request.signal.addEventListener("abort", end, { once: true });
    },
    cancel(): void {
      release();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const app = new Elysia()
  .get("/slow", async () => {
    process.stdout.write("slow request started\\n");
    await Bun.sleep(Number(process.env.SLOW_MS ?? 1000));
    return "slow done";
  })
  .get("/stream", ({ request }) => eventStream(request, true))
  .get("/endless", ({ request }) => eventStream(request, false))
  .ws("/socket", {
    open(ws): void {
      sockets.set(ws.id, shutdown.onShutdown(() => ws.close(GOING_AWAY, "Server shutting down")));
    },
    close(ws): void {
      sockets.get(ws.id)?.();
      sockets.delete(ws.id);
    },
  });

void serveApi(app, env, services);
`;

// Inside the API directory, so the fixture resolves the app's packages.
const root = mkdtempSync(join(__dirname, ".serve-"));
const fixture = join(root, "fixture.ts");
writeFileSync(fixture, FIXTURE);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface ServedFixture {
  child: Subprocess<"ignore", "pipe", "pipe">;
  origin: string;
  /** Resolves once stdout has printed a line containing `text`. */
  printed(text: string): Promise<void>;
}

async function serve(env: Record<string, string>): Promise<ServedFixture> {
  const child = Bun.spawn([process.execPath, fixture], {
    env: { ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", PORT: "0", LOG_LEVEL: "warn", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  const waiters: Array<{ text: string; resolve: () => void }> = [];
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      output += decoder.decode(chunk, { stream: true });
      for (const waiter of [...waiters]) {
        if (!output.includes(waiter.text)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  })();
  const printed = (text: string): Promise<void> =>
    output.includes(text) ? Promise.resolve() : new Promise((resolve) => waiters.push({ text, resolve }));
  const listening = await Promise.race([
    printed("API listening on").then(() => true),
    child.exited.then(() => false),
  ]);
  if (!listening) throw new Error(`The fixture API exited: ${await new Response(child.stderr).text()}`);
  const port = /API listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1];
  return { child, origin: `http://127.0.0.1:${port}`, printed };
}

async function openStream(url: string): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toBe("retry: 1000\n\n");
  return reader;
}

/** "clean" when the stream ends normally, "reset" when its connection breaks. */
async function streamEnd(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<"clean" | "reset"> {
  try {
    for (;;) {
      if ((await reader.read()).done) return "clean";
    }
  } catch {
    return "reset";
  }
}

function openSocket(url: string): Promise<{ closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const closed = new Promise<number>((settle) => socket.addEventListener("close", (event) => settle(event.code)));
    socket.addEventListener("open", () => resolve({ closed }), { once: true });
    socket.addEventListener("error", () => reject(new Error("The WebSocket did not open")), { once: true });
  });
}

async function stopped(child: Subprocess): Promise<{ code: number; ms: number }> {
  const started = performance.now();
  const code = await child.exited;
  return { code, ms: performance.now() - started };
}

describe("API shutdown", () => {
  it("ends streams and WebSockets at once and exits once in-flight requests finish", async () => {
    const api = await serve({ SHUTDOWN_TIMEOUT: "10", SLOW_MS: "1500" });
    try {
      const stream = await openStream(`${api.origin}/stream`);
      const socket = await openSocket(`${api.origin.replace("http", "ws")}/socket`);
      const slow = fetch(`${api.origin}/slow`).then(async (response) => [response.status, await response.text()]);
      await api.printed("slow request started");
      const signalled = performance.now();
      const ended = streamEnd(stream).then((end) => ({ end, ms: performance.now() - signalled }));

      api.child.kill("SIGTERM");

      const exit = await stopped(api.child);
      expect(await ended).toMatchObject({ end: "clean" });
      expect((await ended).ms).toBeLessThan(500);
      expect(await socket.closed).toBe(1001);
      expect(await slow).toEqual([200, "slow done"]);
      expect(exit.code).toBe(0);
      // The slow request held it for about 1.5 s; streams and sockets did not.
      expect(exit.ms).toBeGreaterThan(1_000);
      expect(exit.ms).toBeLessThan(4_000);
    } finally {
      api.child.kill("SIGKILL");
    }
  }, 20_000);

  it("force-closes connections still open after SHUTDOWN_TIMEOUT and exits", async () => {
    const api = await serve({ SHUTDOWN_TIMEOUT: "1" });
    try {
      const stream = await openStream(`${api.origin}/endless`);
      const ended = streamEnd(stream);

      api.child.kill("SIGTERM");

      const exit = await stopped(api.child);
      expect(exit.code).toBe(0);
      expect(exit.ms).toBeGreaterThan(900);
      expect(exit.ms).toBeLessThan(4_000);
      expect(await ended).toBe("reset");
    } finally {
      api.child.kill("SIGKILL");
    }
  }, 20_000);

  it("exits at once on a second signal", async () => {
    const api = await serve({ SHUTDOWN_TIMEOUT: "30" });
    try {
      await openStream(`${api.origin}/endless`);
      api.child.kill("SIGTERM");
      await Bun.sleep(100);

      api.child.kill("SIGINT");

      const exit = await stopped(api.child);
      expect(exit.code).toBe(1);
      expect(exit.ms).toBeLessThan(1_000);
    } finally {
      api.child.kill("SIGKILL");
    }
  }, 20_000);
});
