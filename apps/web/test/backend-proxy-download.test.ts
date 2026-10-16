import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxyRequest, reportBackendAnswer } from "../src/lib/server/backend-proxy";

/**
 * ⚠ THIS FILE IS IN `test/`, NOT BESIDE THE MODULE, BECAUSE THAT IS WHERE THE
 * SUITE LOOKS. `vitest.config.ts` includes only the `test/` directory — a spec
 * written next to its source is collected by no one and passes forever. There is
 * such a file already: `src/lib/server/backend-proxy.test.ts`.
 */

describe("[TC-PDWEB-030] the proxy carries a file download end to end", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const roundTrip = async (requestHeaders: Record<string, string>, upstreamHeaders: Record<string, string>) => {
    let seen: Headers | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return new Response("bytes", { status: 206, headers: upstreamHeaders });
    });
    const request = new Request("http://app.localhost/api/hosts/h/files/download?path=a.bin", {
      headers: requestHeaders,
    });
    const response = await proxyRequest(request, "http://api:5002/hosts/h/files/download?path=a.bin");
    return { sent: seen, response };
  };

  it("passes Range up so a dropped download resumes instead of restarting", async () => {
    // ⚠ DROPPED HERE, THE FAILURE IS SILENT AND EXPENSIVE: the API answers 200
    // from byte zero, the browser starts the file again, and the only symptom is
    // that a big download never finishes.
    const { sent, response } = await roundTrip({ range: "bytes=1024-", "if-range": '"immutable"' }, { etag: '"immutable"' });
    expect(sent?.get("range")).toBe("bytes=1024-");
    expect(sent?.get("if-range")).toBe('"immutable"');
    expect(response.headers.get("etag")).toBe('"immutable"');
  });

  it("relays the headers that make it a file rather than a page", async () => {
    const { response } = await roundTrip(
      {},
      {
        "content-type": "image/png",
        "content-disposition": "attachment; filename*=UTF-8''shot.png",
        "content-length": "5",
        "content-range": "bytes 0-4/5",
        "accept-ranges": "bytes",
        "x-content-type-options": "nosniff",
      },
    );
    // Without disposition the browser names the file after the route; without
    // length it can show no progress; without the range pair it cannot resume.
    expect(response.headers.get("content-disposition")).toContain("shot.png");
    expect(response.headers.get("content-length")).toBe("5");
    expect(response.headers.get("content-range")).toBe("bytes 0-4/5");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.status).toBe(206);
  });
});

describe("[TC-PDFILE-007] bounded transfer proxy", (): void => {
  afterEach((): void => vi.unstubAllGlobals());
  it("preserves binary chunks and refuses an oversized body before forwarding", async (): Promise<void> => {
    const fetch = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
      expect(new Headers(init.headers).get("x-transfer-offset")).toBe("1048576");
      expect(new Headers(init.headers).get("x-transfer-sha256")).toBe("digest");
      expect(init.body).toEqual(new Uint8Array(1_048_576).fill(255));
      return Response.json({ offset: 2097152 });
    });
    vi.stubGlobal("fetch", fetch);
    const url = "http://localhost/api/hosts/host/file-transfers/job/entries/entry/chunk";
    const request = (size: number): Request => new Request(url, { method: "PUT", body: new Uint8Array(size).fill(255),
      headers: { "x-transfer-offset": "1048576", "x-transfer-sha256": "digest" } });
    const server = { timeout: vi.fn() };
    expect((await proxyRequest(request(1_048_576), "http://localhost/chunk", undefined, server)).status).toBe(200);
    expect(server.timeout.mock.calls.map((call) => call[1])).toEqual([60, 0]);
    expect((await proxyRequest(request(1_048_577), "http://localhost/chunk")).status).toBe(413);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("[TC-PDFILE-012] a file transfer outlasts the proxy's header deadline", (): void => {
  const saved = { proxy: process.env.BACKEND_PROXY_TIMEOUT_MS, check: process.env.BACKEND_TIMEOUT_MS };
  beforeEach((): void => {
    process.env.BACKEND_PROXY_TIMEOUT_MS = "40";
    process.env.BACKEND_TIMEOUT_MS = "20";
  });
  afterEach((): void => {
    for (const [name, value] of [["BACKEND_PROXY_TIMEOUT_MS", saved.proxy], ["BACKEND_TIMEOUT_MS", saved.check]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.unstubAllGlobals();
    // The outage state is module-wide; the next test starts with a reachable API.
    reportBackendAnswer();
  });

  /** An API whose /health answers at once (or never), and whose other routes answer after `delayMs`. */
  const slowApi = (delayMs: number, healthy: boolean) => (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith("/health")) return healthy ? Promise.resolve(new Response("ok")) : Promise.reject(new TypeError("fetch failed"));
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({ state: "committed" })), delayMs);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal?.reason);
      });
    });
  };
  const commit = (): Request =>
    new Request("http://app.localhost/api/hosts/h/file-transfers/t/entries/e/commit", { method: "POST" });

  it("waits for a commit that answers after the deadline a page request is cut at", async (): Promise<void> => {
    vi.stubGlobal("fetch", slowApi(120, true));
    const server = { timeout: vi.fn() };
    const committed = await proxyRequest(commit(), "http://api:5002/hosts/h/file-transfers/t/entries/e/commit", undefined, server);
    expect(committed.status).toBe(200);
    expect(await committed.json()).toEqual({ state: "committed" });
    expect(server.timeout.mock.calls.map((call) => call[1])).toEqual([60, 0]);

    const page = await proxyRequest(new Request("http://app.localhost/api/hosts/h"), "http://api:5002/hosts/h");
    expect(page.status).toBe(504);
    expect(await page.json()).toMatchObject({ error: { code: "BACKEND_TIMEOUT" } });
  });

  it("still fails a waiting transfer when the API stops answering", async (): Promise<void> => {
    vi.stubGlobal("fetch", slowApi(10_000, false));
    const response = await proxyRequest(commit(), "http://api:5002/hosts/h/file-transfers/t/entries/e/commit");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "BACKEND_UNAVAILABLE" } });
  });
});
