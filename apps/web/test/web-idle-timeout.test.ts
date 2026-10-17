import { readFileSync } from "node:fs";
import type { RequestEvent } from "@sveltejs/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkIdleTimeout, upstreamFetchOptions } from "../src/lib/server/backend-proxy";
import { APP_PROXY_TIMEOUTS } from "../src/lib/server/proxy-timeouts";
import { POST as proxyApi } from "../src/routes/api/[...path]/+server";
import { POST as proxyMcp } from "../src/routes/mcp/+server";

const repository = new URL("../../../", import.meta.url);
/** BACKEND_PROXY_TIMEOUT_MS, which no shipped configuration changes. */
const PROXY_TIMEOUT_MS = 30_000;
const read = (path: string): string => readFileSync(new URL(path, repository), "utf8");

/** Each committed place that starts the built web server, and how it sets the idle timeout. */
const SHIPPED = [
  { file: "apps/web/Dockerfile", pattern: /^ENV CONNECTION_IDLE_TIMEOUT=(\S+)$/m },
  { file: ".env.example", pattern: /^CONNECTION_IDLE_TIMEOUT=(\S+)$/m },
  { file: "infra/k3s/configmap.yaml", pattern: /^\s+CONNECTION_IDLE_TIMEOUT: "(\S+)"$/m },
] as const;

describe("[TC-PDFILE-012] the built web server keeps a waiting transfer open", () => {
  it("turns the idle timeout off wherever it is configured, as the transfer route requires", () => {
    for (const { file, pattern } of SHIPPED) {
      const value = pattern.exec(read(file))?.[1];
      // Unset is Bun's 10 seconds, which cuts a commit that waits longer.
      expect({ file, value }).toEqual({ file, value: "0" });
      expect(() => checkIdleTimeout(value, PROXY_TIMEOUT_MS, APP_PROXY_TIMEOUTS)).not.toThrow();
    }
    // Compose takes the image's value; a second, different one would win over it.
    expect(read("infra/docker/selfhost.compose.yml")).not.toMatch(/CONNECTION_IDLE_TIMEOUT/);
    // The proxy's own fetch would give up after 5 silent minutes, which a commit can
    // reach behind the host's lock; without a deadline the proxy turns that off itself.
    const transfers = APP_PROXY_TIMEOUTS.find((entry) => entry.pathPrefix === "/api/hosts/:hostId/file-transfers");
    expect(transfers?.timeoutMs).toBeNull();
    expect(upstreamFetchOptions(transfers ? transfers.timeoutMs : 0)).toEqual({ timeout: false });
    expect(read("apps/web/Dockerfile")).not.toMatch(/BUN_CONFIG_HTTP_IDLE_TIMEOUT/);
  });

  it("would refuse to load with any finite idle timeout", () => {
    for (const seconds of ["35", "255"]) {
      expect(() => checkIdleTimeout(seconds, PROXY_TIMEOUT_MS, APP_PROXY_TIMEOUTS)).toThrow(
        /CONNECTION_IDLE_TIMEOUT=\d+ .*\(no deadline, APP_PROXY_TIMEOUTS for \/api\/hosts\/:hostId\/file-transfers\)/,
      );
    }
  });
});

/** A body that sends each text after its delay in milliseconds and stops if the reader goes away. */
const delayedBody = (parts: ReadonlyArray<readonly [number, string]>): ReadableStream<Uint8Array> => {
  const timers: ReturnType<typeof setTimeout>[] = [];
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      parts.forEach(([delayMs, text], index) => {
        timers.push(setTimeout(() => {
          controller.enqueue(encoder.encode(text));
          if (index === parts.length - 1) controller.close();
        }, delayMs));
      });
    },
    cancel() {
      for (const timer of timers) clearTimeout(timer);
    },
  });
};

/** An API that answers /health at once and anything else from `answer`. */
const fakeApi = (answer: (request: Request) => Response): ReturnType<typeof Bun.serve> =>
  Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => (new URL(request.url).pathname === "/health" ? new Response("ok") : answer(request)),
  });

/** Run `body` with the web routes pointed at `api`. */
async function withApi<T>(api: ReturnType<typeof Bun.serve>, body: () => Promise<T>): Promise<T> {
  const saved = process.env.BACKEND_INTERNAL_URL;
  process.env.BACKEND_INTERNAL_URL = api.url.origin;
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env.BACKEND_INTERNAL_URL;
    else process.env.BACKEND_INTERNAL_URL = saved;
    await api.stop(true);
  }
}

const routeEvent = (request: Request): RequestEvent =>
  ({ request, url: new URL(request.url), getClientAddress: () => "127.0.0.1" }) as unknown as RequestEvent;

describe("[TC-PDFILE-012] a commit outlasts the web server's idle timeout", () => {
  /** POST a commit (no body, like the controller's) through a web server with this idle timeout. */
  const commit = async (idleTimeout: number): Promise<string> => {
    const web = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout,
      fetch: async (request) => proxyApi(routeEvent(request)),
    });
    try {
      const response = await fetch(new URL("/api/hosts/h/file-transfers/t/entries/e/commit", web.url), { method: "POST" });
      return await response.text();
    } catch (error) {
      return String(error);
    } finally {
      await web.stop(true);
    }
  };

  it("keeps the request open with the shipped setting, and loses it with a short one", async () => {
    // Bun closes a silent connection on a 4-second tick, so with idleTimeout 1 a
    // commit that answers after 5 seconds is cut. Bun 1.4.0 applies the idle
    // timeout only to requests without a body, which is what a commit is.
    const shipped = Number(SHIPPED[0].pattern.exec(read(SHIPPED[0].file))?.[1]);
    const api = fakeApi(() => new Response(delayedBody([[5_000, '{"state":"committed"}']]), {
      headers: { "content-type": "application/json" },
    }));
    const [kept, cut] = await withApi(api, () => Promise.all([commit(shipped), commit(1)]));
    expect(kept).toBe('{"state":"committed"}');
    expect(cut).not.toContain("committed");
  }, 15_000);
});

describe("[TC-PDMCP-063] an MCP call longer than the proxy deadline still answers", () => {
  const saved = process.env.BACKEND_PROXY_TIMEOUT_MS;
  beforeEach((): void => {
    process.env.BACKEND_PROXY_TIMEOUT_MS = "300";
  });
  afterEach((): void => {
    if (saved === undefined) delete process.env.BACKEND_PROXY_TIMEOUT_MS;
    else process.env.BACKEND_PROXY_TIMEOUT_MS = saved;
  });

  /**
   * The API answers MCP in SSE mode: the SDK sends a keep-alive comment every 15
   * seconds until the tool's result, so the response starts within 15 seconds
   * however long `run_command` runs (up to ten minutes), inside the proxy's
   * 30-second wait for response headers, and every hop sees bytes at least that
   * often. Bun sends response headers only with the first body bytes, so an
   * answer silent past the deadline would be a 504.
   */
  const mcpApi = (keepAliveMs: number | null): ReturnType<typeof Bun.serve> =>
    fakeApi(() => new Response(
      delayedBody([
        ...(keepAliveMs === null ? [] : [[keepAliveMs, ": keepalive\n\n"] as const]),
        [900, 'event: message\ndata: {"result":"done"}\n\n'],
      ]),
      { headers: { "content-type": "text/event-stream" } },
    ));
  const call = async (): Promise<Response> =>
    proxyMcp(routeEvent(new Request("https://dash.example.com/mcp", { method: "POST", body: "{}" })));

  it("streams the result that comes after the deadline once a keep-alive has started the response", async () => {
    const response = await withApi(mcpApi(100), async () => {
      const answer = await call();
      return { status: answer.status, type: answer.headers.get("content-type"), body: await answer.text() };
    });
    expect(response).toEqual({
      status: 200,
      type: "text/event-stream",
      body: ': keepalive\n\nevent: message\ndata: {"result":"done"}\n\n',
    });
  });

  it("answers 504 when nothing arrives before the deadline", async () => {
    const status = await withApi(mcpApi(null), async () => (await call()).status);
    expect(status).toBe(504);
  });
});
