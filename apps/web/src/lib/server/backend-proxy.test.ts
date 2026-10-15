import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyRequest, rawSubpath, resolveClientIp } from "./backend-proxy";

describe("backend proxy client address handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the normalized address from a trusted proxy chain", () => {
    expect(resolveClientIp(() => "::ffff:203.0.113.9")).toBe("203.0.113.9");
  });

  it("omits the address when the proxy header is absent", () => {
    expect(
      resolveClientIp(() => {
        throw new Error("address header is absent");
      }),
    ).toBeUndefined();
  });

  it("omits the address when the proxy chain is too short", () => {
    expect(
      resolveClientIp(() => {
        throw new Error("configured depth exceeds address count");
      }),
    ).toBeUndefined();
  });

  it("does not trust an incoming forwarded header as a fallback", async () => {
    let upstreamHeaders: Headers | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamHeaders = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    });

    const request = new Request("http://app.localhost/api/health", {
      headers: { "x-forwarded-for": "198.51.100.25" },
    });
    const response = await proxyRequest(request, "http://api:5002/health");

    expect(response.status).toBe(204);
    expect(upstreamHeaders?.get("x-forwarded-for")).toBeNull();
  });

  it("forwards a resolved client address", async () => {
    let upstreamHeaders: Headers | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamHeaders = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    });

    const request = new Request("http://app.localhost/api/health");
    const response = await proxyRequest(request, "http://api:5002/health", "203.0.113.9");

    expect(response.status).toBe(204);
    expect(upstreamHeaders?.get("x-forwarded-for")).toBe("203.0.113.9");
  });

  // Not forwarding this does not leave the header unset: fetch substitutes its own
  // default, so the API records "node" for every session and the account page shows
  // that as the device for all of them.
  it("forwards the browser's user agent so sessions record the real device", async () => {
    let upstreamHeaders: Headers | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamHeaders = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    });

    const agent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0.0.0 Safari/537.36";
    const request = new Request("http://app.localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "user-agent": agent },
    });
    const response = await proxyRequest(request, "http://api:5002/auth/sign-in/email");

    expect(response.status).toBe(204);
    expect(upstreamHeaders?.get("user-agent")).toBe(agent);
  });

  it("aborts the upstream request when the client disconnects", async () => {
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Response(null, { status: 204 });
    });

    const client = new AbortController();
    const request = new Request("http://app.localhost/api/events", { signal: client.signal });
    await proxyRequest(request, "http://api:5002/events");

    expect(upstreamSignal).toBeDefined();
    expect(upstreamSignal?.aborted).toBe(false);
    client.abort();
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it("relays rate-limit response headers to browser clients", async () => {
    vi.stubGlobal("fetch", async () => new Response(
      JSON.stringify({ success: false }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "17",
          "ratelimit-limit": "300",
          "ratelimit-remaining": "0",
        },
      },
    ));

    const response = await proxyRequest(
      new Request("http://app.localhost/api/cache/key"),
      "http://api:5002/cache/key",
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(response.headers.get("ratelimit-limit")).toBe("300");
    expect(response.headers.get("ratelimit-remaining")).toBe("0");
  });

  it("relays the next-page cursor of a cursor-paged list", async () => {
    vi.stubGlobal("fetch", async () => new Response("[]", {
      headers: { "content-type": "application/json", "x-next-cursor": "WyIyMDI2Il0" },
    }));

    const response = await proxyRequest(
      new Request("http://app.localhost/api/audit-logs?limit=15"),
      "http://api:5002/audit-logs?limit=15",
    );

    expect(response.headers.get("x-next-cursor")).toBe("WyIyMDI2Il0");
  });

  it("relays cache validator and download headers", async () => {
    vi.stubGlobal("fetch", async () => new Response("report", {
      headers: {
        "content-type": "text/csv",
        etag: '"report-v3"',
        "last-modified": "Wed, 14 Oct 2026 08:00:00 GMT",
        "content-disposition": 'attachment; filename="report.csv"',
        vary: "accept-encoding, cookie",
        "x-content-type-options": "nosniff",
      },
    }));

    const response = await proxyRequest(
      new Request("http://app.localhost/api/reports/3"),
      "http://api:5002/reports/3",
    );

    expect(response.headers.get("etag")).toBe('"report-v3"');
    expect(response.headers.get("last-modified")).toBe("Wed, 14 Oct 2026 08:00:00 GMT");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="report.csv"');
    expect(response.headers.get("vary")).toBe("accept-encoding, cookie");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("relays content-length for an uncompressed upstream body", async () => {
    vi.stubGlobal("fetch", async () => new Response("0123456789", {
      headers: { "content-length": "10" },
    }));

    const response = await proxyRequest(
      new Request("http://app.localhost/api/files/1"),
      "http://api:5002/files/1",
    );

    expect(response.headers.get("content-length")).toBe("10");
    expect(await response.text()).toBe("0123456789");
  });

  it("drops content-length when the upstream body was compressed", async () => {
    vi.stubGlobal("fetch", async () => new Response("decoded body", {
      headers: { "content-encoding": "gzip", "content-length": "4" },
    }));

    const response = await proxyRequest(
      new Request("http://app.localhost/api/files/1"),
      "http://api:5002/files/1",
    );

    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe("decoded body");
  });

  it("delivers a gzip-encoded upstream body in full", async () => {
    const payload = `${"podokit ".repeat(4096)}end`;
    const compressed = gzipSync(payload);
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/plain",
        "content-encoding": "gzip",
        "content-length": String(compressed.byteLength),
      });
      response.end(compressed);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await proxyRequest(
        new Request("http://app.localhost/api/export"),
        `http://127.0.0.1:${String(port)}/export`,
      );

      expect(response.headers.get("content-length")).toBeNull();
      expect(await response.text()).toBe(payload);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("forwards conditional and range request headers", async () => {
    let upstreamHeaders: Headers | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamHeaders = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    });

    const request = new Request("http://app.localhost/api/files/1", {
      headers: {
        "if-none-match": '"file-v1"',
        "if-modified-since": "Wed, 14 Oct 2026 08:00:00 GMT",
        range: "bytes=0-99",
        "if-range": '"file-v1"',
      },
    });
    await proxyRequest(request, "http://api:5002/files/1");

    expect(upstreamHeaders?.get("if-none-match")).toBe('"file-v1"');
    expect(upstreamHeaders?.get("if-modified-since")).toBe("Wed, 14 Oct 2026 08:00:00 GMT");
    expect(upstreamHeaders?.get("range")).toBe("bytes=0-99");
    expect(upstreamHeaders?.get("if-range")).toBe('"file-v1"');
  });

  it("passes a 304 Not Modified response through without a body", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, {
      status: 304,
      headers: { etag: '"file-v1"', "cache-control": "private, no-cache" },
    }));

    const response = await proxyRequest(
      new Request("http://app.localhost/api/files/1", {
        headers: { "if-none-match": '"file-v1"' },
      }),
      "http://api:5002/files/1",
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe('"file-v1"');
    expect(await response.text()).toBe("");
  });

  it("passes a 206 Partial Content response through with its range", async () => {
    vi.stubGlobal("fetch", async () => new Response("0123", {
      status: 206,
      headers: {
        "content-range": "bytes 0-3/10",
        "accept-ranges": "bytes",
        "content-length": "4",
      },
    }));

    const response = await proxyRequest(
      new Request("http://app.localhost/api/files/1", { headers: { range: "bytes=0-3" } }),
      "http://api:5002/files/1",
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe("4");
    expect(await response.text()).toBe("0123");
  });
});

describe("backend proxy raw path", () => {
  it("keeps encoded separators inside a path segment", () => {
    const url = new URL("http://localhost/api/files/uploads%2Fu1%2Fa%3Fb.png/url?x=1");
    expect(rawSubpath(url, "/api/")).toBe("files/uploads%2Fu1%2Fa%3Fb.png/url");
  });

  it("strips only the given prefix", () => {
    expect(rawSubpath(new URL("http://localhost/api/auth/get-session"), "/api/auth/")).toBe("get-session");
    expect(rawSubpath(new URL("http://localhost/other"), "/api/")).toBe("/other");
  });
});
