import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backendReachable,
  bodyLimitFor,
  checkBackend,
  checkIdleTimeout,
  configuredPublicOrigins,
  envMilliseconds,
  IN_MEMORY_RESPONSE_BYTES,
  proxyRequest,
  proxyTimeoutFor,
  reportBackendAnswer,
  rawSubpath,
  resolveClientIp,
  sortedBodyLimits,
  sortedProxyTimeouts,
  upstreamFetchOptions,
  withAppHeaders,
} from "./backend-proxy";

describe("backend proxy client address handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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

  it("forwards the public origin a request came in on when CORS_ORIGIN lists it", async () => {
    let upstreamHeaders: Headers | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamHeaders = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    });
    vi.stubEnv("CORS_ORIGIN", "https://example.com,https://mirror.example.com");

    // The adapter builds the request URL from the gateway's forwarded host and
    // protocol; a caller's own forwarded headers never reach the API.
    const request = new Request("https://mirror.example.com/api/mcp/info", {
      headers: { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http" },
    });
    await proxyRequest(request, "http://api:5002/mcp/info");

    expect(upstreamHeaders?.get("x-forwarded-host")).toBe("mirror.example.com");
    expect(upstreamHeaders?.get("x-forwarded-proto")).toBe("https");
  });

  it("forwards no origin that CORS_ORIGIN does not list", async () => {
    let upstreamHeaders: Headers | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamHeaders = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    });
    vi.stubEnv("CORS_ORIGIN", "https://example.com");

    const request = new Request("http://attacker.example/api/mcp/info", {
      headers: { "x-forwarded-host": "example.com", "x-forwarded-proto": "https" },
    });
    await proxyRequest(request, "http://api:5002/mcp/info");

    expect(upstreamHeaders?.has("x-forwarded-host")).toBe(false);
    expect(upstreamHeaders?.has("x-forwarded-proto")).toBe(false);
  });

  it("reads absolute CORS_ORIGIN entries as origins and skips patterns", () => {
    expect([...configuredPublicOrigins(" https://example.com/ , *.example.com, not a url, http://localhost:5001")])
      .toEqual(["https://example.com", "http://localhost:5001"]);
    expect(configuredPublicOrigins("").size).toBe(0);
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

  it("reads a body of known, modest size before relaying it, so Bun keeps its length", async () => {
    let pulls = 0;
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller): void {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("0123456789"));
        controller.close();
      },
    }, { highWaterMark: 0 }), { headers: { "content-length": "10" } }));

    const response = await proxyRequest(
      new Request("http://app.localhost/api/profile-images/a.png"),
      "http://api:5002/profile-images/a.png",
    );

    expect(pulls).toBe(1);
    expect(response.headers.get("content-length")).toBe("10");
    expect(await response.text()).toBe("0123456789");
  });

  it("streams a larger body through without reading it first", async () => {
    const size = IN_MEMORY_RESPONSE_BYTES + 1;
    let pulls = 0;
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller): void {
        pulls += 1;
        controller.enqueue(new Uint8Array(size));
        controller.close();
      },
    }, { highWaterMark: 0 }), { headers: { "content-length": String(size) } }));

    const response = await proxyRequest(
      new Request("http://app.localhost/api/storage/large"),
      "http://api:5002/storage/large",
    );

    expect(pulls).toBe(0);
    expect(response.headers.get("content-length")).toBe(String(size));
    expect((await response.arrayBuffer()).byteLength).toBe(size);
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

describe("backend proxy application header lists", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("./proxy-headers");
    vi.resetModules();
  });

  async function proxyWithAppHeaders(request: string[], response: string[]): Promise<typeof proxyRequest> {
    vi.resetModules();
    vi.doMock("./proxy-headers", () => ({
      APP_FORWARDED_REQUEST_HEADERS: request,
      APP_RELAYED_RESPONSE_HEADERS: response,
    }));
    return (await import("./backend-proxy")).proxyRequest;
  }

  it("forwards and relays the headers an application lists", async () => {
    const proxy = await proxyWithAppHeaders(["X-API-Key", "mcp-session-id"], ["X-Checksum-SHA256", "www-authenticate"]);
    let upstreamHeaders: Headers | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamHeaders = new Headers(init?.headers);
      return new Response(null, {
        status: 401,
        headers: {
          "x-checksum-sha256": "abc123",
          "www-authenticate": "Bearer",
          "x-internal-trace": "hidden",
        },
      });
    });

    const response = await proxy(
      new Request("http://app.localhost/api/documents/1", {
        headers: { "x-api-key": "key", "mcp-session-id": "s1", "x-unlisted": "dropped" },
      }),
      "http://api:5002/documents/1",
    );

    expect(upstreamHeaders?.get("x-api-key")).toBe("key");
    expect(upstreamHeaders?.get("mcp-session-id")).toBe("s1");
    expect(upstreamHeaders?.get("x-unlisted")).toBeNull();
    expect(response.headers.get("x-checksum-sha256")).toBe("abc123");
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(response.headers.get("x-internal-trace")).toBeNull();
  });

  it("drops application headers that no list names", async () => {
    const proxy = await proxyWithAppHeaders([], []);
    let upstreamHeaders: Headers | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamHeaders = new Headers(init?.headers);
      return new Response(null, { status: 204, headers: { "x-checksum-sha256": "abc123" } });
    });

    const response = await proxy(
      new Request("http://app.localhost/api/documents/1", { headers: { "x-api-key": "key" } }),
      "http://api:5002/documents/1",
    );

    expect(upstreamHeaders?.get("x-api-key")).toBeNull();
    expect(response.headers.get("x-checksum-sha256")).toBeNull();
  });

  it("refuses to load with a reserved or invalid application header", async () => {
    await expect(proxyWithAppHeaders(["x-forwarded-for"], [])).rejects.toThrow(
      'APP_FORWARDED_REQUEST_HEADERS cannot contain "x-forwarded-for"',
    );
    await expect(proxyWithAppHeaders([], ["Set-Cookie"])).rejects.toThrow(
      'APP_RELAYED_RESPONSE_HEADERS cannot contain "set-cookie"',
    );
  });

  it("lowercases, deduplicates, and validates application names", () => {
    const reserved = new Set(["host", "transfer-encoding"]);
    expect(withAppHeaders(["accept", "etag"], ["ETag", "X-Trace", "x-trace"], reserved, "LIST")).toEqual([
      "accept",
      "etag",
      "x-trace",
    ]);
    expect(() => withAppHeaders([], ["Transfer-Encoding"], reserved, "LIST")).toThrow(
      'LIST cannot contain "transfer-encoding"',
    );
    expect(() => withAppHeaders([], ["x trace"], reserved, "LIST")).toThrow(
      'LIST contains an invalid header name: "x trace"',
    );
    expect(() => withAppHeaders([], [""], reserved, "LIST")).toThrow("invalid header name");
  });
});

describe("backend proxy application body limits", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("./body-limits");
    vi.resetModules();
  });

  async function proxyWithBodyLimits(
    limits: ReadonlyArray<{ pathPrefix: string; maxBytes: number }>,
  ): Promise<typeof proxyRequest> {
    vi.resetModules();
    vi.doMock("./body-limits", () => ({ APP_BODY_LIMITS: limits }));
    return (await import("./backend-proxy")).proxyRequest;
  }

  function recordingFetch(): { bodies: Uint8Array[] } {
    const record = { bodies: [] as Uint8Array[] };
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      record.bodies.push(new Uint8Array(await new Response(init?.body).arrayBuffer()));
      return new Response(null, { status: 204 });
    });
    return record;
  }

  // A body without content-length, as a chunked upload arrives.
  function streamedRequest(url: string, chunks: number, chunkSize: number): { request: Request; pulled: () => number } {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled === chunks) {
          controller.close();
          return;
        }
        pulled += 1;
        controller.enqueue(new Uint8Array(chunkSize).fill(pulled));
      },
    });
    const init = { method: "POST", body: stream, duplex: "half" } as RequestInit;
    return { request: new Request(url, init), pulled: () => pulled };
  }

  it("rejects a declared body above the route limit before contacting the API", async () => {
    const proxy = await proxyWithBodyLimits([{ pathPrefix: "/api/feedback/", maxBytes: 8 }]);
    const record = recordingFetch();

    const response = await proxy(
      new Request("http://app.localhost/api/feedback/new", { method: "POST", body: "0123456789" }),
      "http://api:5002/feedback/new",
    );

    expect(response.status).toBe(413);
    const envelope = (await response.json()) as {
      success: boolean;
      error: { code: string; statusCode: number; path: string; details: { maxBytes: number } };
    };
    expect(envelope.success).toBe(false);
    expect(envelope.error).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      statusCode: 413,
      path: "/api/feedback/new",
      details: { maxBytes: 8 },
    });
    expect(record.bodies).toEqual([]);
  });

  it("stops reading a streamed body once it passes the limit", async () => {
    const proxy = await proxyWithBodyLimits([{ pathPrefix: "/api/feedback", maxBytes: 10 }]);
    const record = recordingFetch();
    const { request, pulled } = streamedRequest("http://app.localhost/api/feedback", 100, 4);

    const response = await proxy(request, "http://api:5002/feedback");

    expect(response.status).toBe(413);
    expect(record.bodies).toEqual([]);
    expect(pulled()).toBeLessThan(10);
  });

  it("forwards a body within the limit byte-for-byte", async () => {
    const proxy = await proxyWithBodyLimits([{ pathPrefix: "/api/feedback/", maxBytes: 12 }]);
    const record = recordingFetch();
    const { request } = streamedRequest("http://app.localhost/api/feedback/new", 3, 4);

    const response = await proxy(request, "http://api:5002/feedback/new");

    expect(response.status).toBe(204);
    expect([...(record.bodies[0] ?? [])]).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
  });

  it("leaves routes without a limit to the server-wide ceiling", async () => {
    const proxy = await proxyWithBodyLimits([{ pathPrefix: "/api/feedback/", maxBytes: 1 }]);
    const record = recordingFetch();

    const response = await proxy(
      new Request("http://app.localhost/api/feedbacks", { method: "POST", body: "0123456789" }),
      "http://api:5002/feedbacks",
    );

    expect(response.status).toBe(204);
    expect(record.bodies[0]?.byteLength).toBe(10);
  });

  it("applies the longest matching prefix on the decoded path", () => {
    const limits = sortedBodyLimits([
      { pathPrefix: "/api/", maxBytes: 100 },
      { pathPrefix: "/api/files/uploads/", maxBytes: 10 },
      { pathPrefix: "/api/files", maxBytes: 50 },
    ]);

    expect(bodyLimitFor("/api/files/uploads/u1/parts/2", limits)).toBe(10);
    expect(bodyLimitFor("/api/files/uploads", limits)).toBe(10);
    expect(bodyLimitFor("/api/files/u1", limits)).toBe(50);
    expect(bodyLimitFor("/api/filesystem", limits)).toBe(100);
    expect(bodyLimitFor("/api/%66iles/uploads/u1", limits)).toBe(10);
    expect(bodyLimitFor("/api/files%2Fuploads/u1", limits)).toBe(10);
    expect(bodyLimitFor("/api/files/%E0%A4%A", limits)).toBe(50);
    expect(bodyLimitFor("/other", limits)).toBeUndefined();
  });

  it("matches :name parameters against one non-empty segment, most specific rule first", () => {
    const limits = sortedBodyLimits([
      { pathPrefix: "/api/hosts", maxBytes: 100 },
      { pathPrefix: "/api/hosts/:hostId/file-transfers", maxBytes: 1_048_576 },
      { pathPrefix: "/api/hosts/local/:section", maxBytes: 10 },
      { pathPrefix: "/api/hosts/:hostId/:section/:item", maxBytes: 20 },
    ]);

    expect(bodyLimitFor("/api/hosts/h1/file-transfers", limits)).toBe(1_048_576);
    expect(bodyLimitFor("/api/hosts/h%31/file-transfers", limits)).toBe(1_048_576);
    // More segments win, then a literal segment over a parameter from the left.
    expect(bodyLimitFor("/api/hosts/h1/file-transfers/t1/chunk", limits)).toBe(20);
    expect(bodyLimitFor("/api/hosts/local/file-transfers", limits)).toBe(10);
    expect(bodyLimitFor("/api/hosts/h1/file-transfers-old", limits)).toBe(100);
    expect(bodyLimitFor("/api/hosts/file-transfers", limits)).toBe(100);
    expect(bodyLimitFor("/api/hosts//file-transfers", limits)).toBe(100);
    expect(bodyLimitFor("/api/other", limits)).toBeUndefined();
  });

  it("caps the body of a route with a path parameter", async () => {
    const proxy = await proxyWithBodyLimits([{ pathPrefix: "/api/hosts/:hostId/file-transfers", maxBytes: 8 }]);
    const record = recordingFetch();

    const capped = await proxy(
      new Request("http://app.localhost/api/hosts/h1/file-transfers/t1/chunk", { method: "POST", body: "0123456789" }),
      "http://api:5002/hosts/h1/file-transfers/t1/chunk",
    );
    const other = await proxy(
      new Request("http://app.localhost/api/hosts/h1/notes", { method: "POST", body: "0123456789" }),
      "http://api:5002/hosts/h1/notes",
    );

    expect(capped.status).toBe(413);
    expect(other.status).toBe(204);
    expect(record.bodies.map((body) => body.byteLength)).toEqual([10]);
  });

  it.each<[{ pathPrefix: string; maxBytes: number }[], string]>([
    [[{ pathPrefix: "/feedback/", maxBytes: 10 }], "must be a path under /api/"],
    [[{ pathPrefix: "/api/files/*", maxBytes: 10 }], "must be a path under /api/"],
    [[{ pathPrefix: "/api//files", maxBytes: 10 }], "must be a path under /api/"],
    [[{ pathPrefix: "/api/files/../admin", maxBytes: 10 }], "must be a path under /api/"],
    [[{ pathPrefix: "/api/files", maxBytes: 0 }], "positive whole number"],
    [[{ pathPrefix: "/api/files", maxBytes: 1.5 }], "positive whole number"],
    [[{ pathPrefix: "/apix/files", maxBytes: 10 }], "must be a path under /api/"],
    [[{ pathPrefix: "/api/files/:", maxBytes: 10 }], "must be a path under /api/"],
    [[{ pathPrefix: "/api/files/:1st", maxBytes: 10 }], "must be a path under /api/"],
    [[{ pathPrefix: "/api/files/:file-id", maxBytes: 10 }], "must be a path under /api/"],
    [[{ pathPrefix: "/api/files/:a:b", maxBytes: 10 }], "must be a path under /api/"],
    [[{ pathPrefix: "/api/files", maxBytes: 10 }, { pathPrefix: "/api/files/", maxBytes: 20 }], "lists the same paths twice"],
    [
      [{ pathPrefix: "/api/hosts/:hostId", maxBytes: 10 }, { pathPrefix: "/api/hosts/:id/", maxBytes: 20 }],
      'lists the same paths twice: "/api/hosts/:hostId" and "/api/hosts/:id/"',
    ],
  ])("rejects an invalid body limit list %#", (limits, message) => {
    expect(() => sortedBodyLimits(limits)).toThrow(message);
  });

  it("refuses to load with an invalid application body limit", async () => {
    await expect(proxyWithBodyLimits([{ pathPrefix: "/upload", maxBytes: 10 }])).rejects.toThrow(
      "APP_BODY_LIMITS pathPrefix must be a path under /api/",
    );
  });
});

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// Never answers on its own, like a blackholed connection or a hung API, and
// rejects when its signal aborts.
const hang: Fetch = (_input, init) =>
  new Promise((_settle, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });
const refuse: Fetch = async () => {
  throw new TypeError("Unable to connect. Is the computer able to access the url?");
};
// Answers after a delay unless its signal aborts first, like a slow endpoint.
const answerAfter =
  (ms: number): Fetch =>
  (_input, init) =>
    new Promise((settle, reject) => {
      const timer = setTimeout(() => settle(Response.json({ done: true })), ms);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal?.reason);
      });
    });

// Routes the background GET /health check and the proxied request separately.
function stubApi(health: Fetch, upstream: Fetch): ReturnType<typeof vi.fn<Fetch>> {
  const fetch = vi.fn<Fetch>((input, init) =>
    String(input).endsWith("/health") ? health(input, init) : upstream(input, init),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("backend proxy outages", () => {
  afterEach(() => {
    reportBackendAnswer();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function takeApiDown(): Promise<void> {
    stubApi(refuse, refuse);
    await checkBackend();
    expect(backendReachable()).toBe(false);
  }

  it("answers 503 with the error envelope when the API cannot be reached", async () => {
    stubApi(refuse, refuse);

    const response = await proxyRequest(new Request("http://app.localhost/api/blog"), "http://api:5002/blog");

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: "BACKEND_UNAVAILABLE", statusCode: 503, path: "/api/blog" },
    });
    await checkBackend();
    expect(backendReachable()).toBe(false);
  });

  it("answers 504 when the API sends no response headers before the deadline", async () => {
    vi.stubEnv("BACKEND_PROXY_TIMEOUT_MS", "20");
    stubApi(async () => new Response("ok"), hang);

    const response = await proxyRequest(new Request("http://app.localhost/api/report"), "http://api:5002/report");

    expect(response.status).toBe(504);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.json()).toMatchObject({ error: { code: "BACKEND_TIMEOUT", statusCode: 504 } });
    await checkBackend();
    expect(backendReachable()).toBe(true);
  });

  it("fails requests still waiting for headers once the API is found unreachable", async () => {
    vi.stubEnv("BACKEND_TIMEOUT_MS", "20");
    stubApi(hang, hang);

    const started = Date.now();
    const response = await proxyRequest(new Request("http://app.localhost/api/blog"), "http://api:5002/blog");

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "BACKEND_UNAVAILABLE" } });
    expect(backendReachable()).toBe(false);
  });

  it("keeps waiting for a slow endpoint while the API answers its health checks", async () => {
    vi.stubEnv("BACKEND_INTERNAL_URL", "http://api:5002");
    vi.stubEnv("BACKEND_TIMEOUT_MS", "20");
    const fetch = stubApi(async () => new Response("ok"), answerAfter(100));

    const response = await proxyRequest(new Request("http://app.localhost/api/report"), "http://api:5002/report");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ done: true });
    const [first, ...checks] = fetch.mock.calls.map(([input]) => String(input));
    expect(first).toBe("http://api:5002/report");
    expect(checks.length).toBeGreaterThanOrEqual(2);
    expect(new Set(checks)).toEqual(new Set(["http://api:5002/health"]));
    expect(backendReachable()).toBe(true);
  });

  it("fails a waiting request when the API stops answering after an earlier check", async () => {
    vi.stubEnv("BACKEND_TIMEOUT_MS", "20");
    vi.stubEnv("BACKEND_PROXY_TIMEOUT_MS", "10000");
    let checks = 0;
    stubApi((input, init) => (++checks <= 2 ? Promise.resolve(new Response("ok")) : hang(input, init)), hang);

    const started = Date.now();
    const response = await proxyRequest(new Request("http://app.localhost/api/report"), "http://api:5002/report");

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "BACKEND_UNAVAILABLE" } });
    expect(checks).toBeGreaterThanOrEqual(3);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("answers at once without contacting the API while it is unreachable", async () => {
    await takeApiDown();
    const fetch = stubApi(refuse, async () => new Response(null, { status: 204 }));

    const response = await proxyRequest(
      new Request("http://app.localhost/api/blog", { method: "POST", body: "{}" }),
      "http://api:5002/blog",
    );

    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks the API again after the retry interval and recovers on any HTTP answer", async () => {
    await takeApiDown();
    const fetch = stubApi(async () => new Response("unavailable", { status: 500 }), refuse);

    expect(backendReachable(Date.now() + 2_000)).toBe(false);
    await checkBackend();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(backendReachable()).toBe(true);
  });

  it("relays an error status without checking the API", async () => {
    const fetch = stubApi(refuse, async () => Response.json({ success: false }, { status: 500 }));

    const response = await proxyRequest(new Request("http://app.localhost/api/blog"), "http://api:5002/blog");

    expect(response.status).toBe(500);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(backendReachable()).toBe(true);
  });

  it("does not report a browser that disconnected as an outage", async () => {
    const fetch = stubApi(refuse, hang);
    const client = new AbortController();
    const pending = proxyRequest(
      new Request("http://app.localhost/api/events", { signal: client.signal }),
      "http://api:5002/events",
    );
    client.abort();

    await expect(pending).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(backendReachable()).toBe(true);
  });

  it("stops the deadline once response headers arrive, so a stream keeps flowing", async () => {
    vi.stubEnv("BACKEND_PROXY_TIMEOUT_MS", "20");
    let upstreamSignal: AbortSignal | undefined;
    stubApi(refuse, async (_input, init) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
    });

    const response = await proxyRequest(new Request("http://app.localhost/api/events"), "http://api:5002/events");
    await new Promise((settle) => setTimeout(settle, 60));

    expect(response.status).toBe(200);
    expect(upstreamSignal?.aborted).toBe(false);
  });

  it.each(["0", "-1", "1.5", "soon", "2147483648"])("rejects the invalid timeout %s", (value) => {
    vi.stubEnv("BACKEND_TIMEOUT_MS", value);
    expect(() => envMilliseconds("BACKEND_TIMEOUT_MS", 2_000)).toThrow("whole number of milliseconds");
  });

  it("uses the default timeout when the variable is unset or empty", () => {
    vi.stubEnv("BACKEND_TIMEOUT_MS", "");
    expect(envMilliseconds("BACKEND_TIMEOUT_MS", 2_000)).toBe(2_000);
    vi.stubEnv("BACKEND_TIMEOUT_MS", "1500");
    expect(envMilliseconds("BACKEND_TIMEOUT_MS", 2_000)).toBe(1_500);
  });
});

describe("backend proxy application timeouts", () => {
  // The module checks CONNECTION_IDLE_TIMEOUT against the routes when it loads,
  // so a value from the developer's .env, such as the example's 35, would refuse
  // the routes without a deadline below. Tests of that check set their own.
  beforeEach(() => {
    vi.stubEnv("CONNECTION_IDLE_TIMEOUT", "0");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.doUnmock("./proxy-timeouts");
    vi.resetModules();
  });

  async function proxyWithTimeouts(
    timeouts: ReadonlyArray<{ pathPrefix: string; timeoutMs: number | null }>,
  ): Promise<typeof proxyRequest> {
    vi.resetModules();
    vi.doMock("./proxy-timeouts", () => ({ APP_PROXY_TIMEOUTS: timeouts }));
    return (await import("./backend-proxy")).proxyRequest;
  }

  it("waits longer on a route with a longer deadline", async () => {
    vi.stubEnv("BACKEND_PROXY_TIMEOUT_MS", "20");
    const proxy = await proxyWithTimeouts([{ pathPrefix: "/api/exports/", timeoutMs: 2_000 }]);
    stubApi(async () => new Response("ok"), answerAfter(80));

    const listed = await proxy(new Request("http://app.localhost/api/exports/42"), "http://api:5002/exports/42");
    const other = await proxy(new Request("http://app.localhost/api/report"), "http://api:5002/report");

    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ done: true });
    expect(other.status).toBe(504);
  });

  it("answers 504 at a route's shorter deadline", async () => {
    const proxy = await proxyWithTimeouts([{ pathPrefix: "/api/quick", timeoutMs: 20 }]);
    stubApi(async () => new Response("ok"), hang);

    const started = Date.now();
    const response = await proxy(new Request("http://app.localhost/api/quick/check"), "http://api:5002/quick/check");

    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: { code: "BACKEND_TIMEOUT", path: "/api/quick/check" } });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("waits without a deadline on a null route until the API answers", async () => {
    vi.stubEnv("BACKEND_TIMEOUT_MS", "20");
    vi.stubEnv("BACKEND_PROXY_TIMEOUT_MS", "20");
    const proxy = await proxyWithTimeouts([{ pathPrefix: "/api/file-transfers/", timeoutMs: null }]);
    stubApi(async () => new Response("ok"), answerAfter(150));

    const response = await proxy(
      new Request("http://app.localhost/api/file-transfers/7/commit", { method: "POST", body: "{}" }),
      "http://api:5002/file-transfers/7/commit",
    );

    expect(response.status).toBe(200);
  });

  it("still answers 503 on a null route once the API is found unreachable", async () => {
    vi.stubEnv("BACKEND_TIMEOUT_MS", "20");
    const proxy = await proxyWithTimeouts([{ pathPrefix: "/api/file-transfers/", timeoutMs: null }]);
    let checks = 0;
    stubApi((input, init) => (++checks <= 2 ? Promise.resolve(new Response("ok")) : hang(input, init)), hang);

    const response = await proxy(
      new Request("http://app.localhost/api/file-transfers/7/commit", { method: "POST", body: "{}" }),
      "http://api:5002/file-transfers/7/commit",
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(await response.json()).toMatchObject({
      error: { code: "BACKEND_UNAVAILABLE", path: "/api/file-transfers/7/commit" },
    });
    expect(checks).toBeGreaterThanOrEqual(3);
  });

  it("turns off Bun's fetch idle timeout on a route without a deadline only", async () => {
    const proxy = await proxyWithTimeouts([{ pathPrefix: "/api/hosts/:hostId/file-transfers", timeoutMs: null }]);
    const fetch = stubApi(async () => new Response("ok"), async () => Response.json({ done: true }));

    await proxy(
      new Request("http://app.localhost/api/hosts/h1/file-transfers/t1/commit", { method: "POST", body: "{}" }),
      "http://api:5002/hosts/h1/file-transfers/t1/commit",
    );
    await proxy(new Request("http://app.localhost/api/hosts/h1/notes"), "http://api:5002/hosts/h1/notes");

    const upstream = fetch.mock.calls.filter(([input]) => !String(input).endsWith("/health"));
    const [commit, notes] = upstream.map(([, init]) => init as RequestInit & { timeout?: unknown });
    expect(upstream).toHaveLength(2);
    expect(commit?.timeout).toBe(false);
    expect(notes).not.toHaveProperty("timeout");
  });

  it("turns off Bun's fetch idle timeout for a deadline it would cut first", async () => {
    expect(upstreamFetchOptions(null)).toEqual({ timeout: false });
    expect(upstreamFetchOptions(600_000)).toEqual({ timeout: false });
    expect(upstreamFetchOptions(300_000)).toEqual({ timeout: false });
    expect(upstreamFetchOptions(299_999)).toEqual({});
    expect(upstreamFetchOptions(30_000)).toEqual({});

    vi.stubEnv("BACKEND_PROXY_TIMEOUT_MS", "300000");
    vi.stubEnv("CONNECTION_IDLE_TIMEOUT", "0");
    const proxy = await proxyWithTimeouts([]);
    const fetch = stubApi(async () => new Response("ok"), async () => Response.json({ done: true }));

    await proxy(new Request("http://app.localhost/api/report"), "http://api:5002/report");

    expect(fetch.mock.calls[0]?.[1]).toHaveProperty("timeout", false);
  });

  it("waits without a deadline on a route with a path parameter", async () => {
    vi.stubEnv("BACKEND_PROXY_TIMEOUT_MS", "20");
    const proxy = await proxyWithTimeouts([{ pathPrefix: "/api/hosts/:hostId/file-transfers", timeoutMs: null }]);
    stubApi(async () => new Response("ok"), answerAfter(80));

    const commit = await proxy(
      new Request("http://app.localhost/api/hosts/h1/file-transfers/t1/commit", { method: "POST", body: "{}" }),
      "http://api:5002/hosts/h1/file-transfers/t1/commit",
    );
    const other = await proxy(new Request("http://app.localhost/api/hosts/h1/notes"), "http://api:5002/hosts/h1/notes");

    expect(commit.status).toBe(200);
    expect(other.status).toBe(504);
  });

  it("applies the longest matching prefix on the decoded path and the default elsewhere", () => {
    vi.stubEnv("BACKEND_PROXY_TIMEOUT_MS", "1234");
    const timeouts = sortedProxyTimeouts([
      { pathPrefix: "/api/", timeoutMs: 5_000 },
      { pathPrefix: "/api/file-transfers/", timeoutMs: null },
      { pathPrefix: "/api/file-transfers/status", timeoutMs: 100 },
    ]);

    expect(proxyTimeoutFor("/api/file-transfers/7/commit", timeouts)).toBeNull();
    expect(proxyTimeoutFor("/api/file-transfers", timeouts)).toBeNull();
    expect(proxyTimeoutFor("/api/file-transfers/status/7", timeouts)).toBe(100);
    expect(proxyTimeoutFor("/api/%66ile-transfers/7", timeouts)).toBeNull();
    expect(proxyTimeoutFor("/api/file-transfers-old/7", timeouts)).toBe(5_000);
    expect(proxyTimeoutFor("/api/auth/get-session", sortedProxyTimeouts([]))).toBe(1234);
    expect(proxyTimeoutFor("/other", timeouts)).toBe(1234);

    const byHost = sortedProxyTimeouts([
      { pathPrefix: "/api/hosts/:hostId/file-transfers", timeoutMs: null },
      { pathPrefix: "/api/hosts/local/file-transfers", timeoutMs: 60_000 },
    ]);
    expect(proxyTimeoutFor("/api/hosts/h1/file-transfers/t1/commit", byHost)).toBeNull();
    expect(proxyTimeoutFor("/api/hosts/local/file-transfers/t1/commit", byHost)).toBe(60_000);
    expect(proxyTimeoutFor("/api/hosts/file-transfers", byHost)).toBe(1234);
  });

  it.each<[{ pathPrefix: string; timeoutMs: number | null }[], string]>([
    [[{ pathPrefix: "/exports/", timeoutMs: 10 }], "must be a path under /api/"],
    [[{ pathPrefix: "/api/exports/*", timeoutMs: 10 }], "must be a path under /api/"],
    [[{ pathPrefix: "/api/exports/../auth", timeoutMs: 10 }], "must be a path under /api/"],
    [[{ pathPrefix: "/api/exports", timeoutMs: 0 }], "must be null or a whole number of milliseconds"],
    [[{ pathPrefix: "/api/exports", timeoutMs: 1.5 }], "must be null or a whole number of milliseconds"],
    [[{ pathPrefix: "/api/exports", timeoutMs: 2_147_483_648 }], "must be null or a whole number of milliseconds"],
    [[{ pathPrefix: "/api/exports/:", timeoutMs: 10 }], "must be a path under /api/"],
    [[{ pathPrefix: "/api/exports", timeoutMs: null }, { pathPrefix: "/api/exports/", timeoutMs: 10 }], "lists the same paths twice"],
    [[{ pathPrefix: "/api/:a/x", timeoutMs: null }, { pathPrefix: "/api/:b/x", timeoutMs: 10 }], "lists the same paths twice"],
  ])("rejects an invalid timeout list %#", (timeouts, message) => {
    expect(() => sortedProxyTimeouts(timeouts)).toThrow(message);
  });

  it.each([undefined, "0", "35", "soon"])("accepts CONNECTION_IDLE_TIMEOUT=%s with the default deadline", (idle) => {
    expect(() => checkIdleTimeout(idle, 30_000, [])).not.toThrow();
  });

  it("requires the idle timeout to outlast the longest deadline by Bun's check interval", () => {
    expect(() => checkIdleTimeout("34", 30_000, [])).toThrow(
      "CONNECTION_IDLE_TIMEOUT=34 lets the web server close a silent connection before the /api proxy stops " +
        "waiting for response headers (30000 ms, BACKEND_PROXY_TIMEOUT_MS)",
    );
    expect(() => checkIdleTimeout("10", 30_000, [])).toThrow("Set CONNECTION_IDLE_TIMEOUT to at least 35, or to 0");
    expect(() => checkIdleTimeout("35", 30_500, [])).not.toThrow();
    expect(() => checkIdleTimeout("35", 31_000, [])).toThrow("at least 36");

    const routes = sortedProxyTimeouts([
      { pathPrefix: "/api/quick/", timeoutMs: 5_000 },
      { pathPrefix: "/api/exports/", timeoutMs: 120_000 },
    ]);
    expect(() => checkIdleTimeout("35", 30_000, routes)).toThrow(
      "(120000 ms, APP_PROXY_TIMEOUTS for /api/exports); Bun closes idle connections up to 4 seconds early. " +
        "Set CONNECTION_IDLE_TIMEOUT to at least 125, or to 0 to turn the idle timeout off.",
    );
    expect(() => checkIdleTimeout("125", 30_000, routes)).not.toThrow();
    expect(() => checkIdleTimeout("0", 30_000, routes)).not.toThrow();
  });

  it("requires the idle timeout off for a route without a deadline or beyond Bun's limit", () => {
    const unbounded = sortedProxyTimeouts([
      { pathPrefix: "/api/exports/", timeoutMs: 120_000 },
      { pathPrefix: "/api/file-transfers/", timeoutMs: null },
    ]);
    expect(() => checkIdleTimeout("255", 30_000, unbounded)).toThrow(
      "(no deadline, APP_PROXY_TIMEOUTS for /api/file-transfers); Bun closes idle connections up to 4 seconds " +
        "early. Set CONNECTION_IDLE_TIMEOUT to 0 to turn the idle timeout off, since Bun allows at most 255 seconds.",
    );
    expect(() => checkIdleTimeout("0", 30_000, unbounded)).not.toThrow();
    expect(() => checkIdleTimeout("255", 250_999, [])).not.toThrow();
    expect(() => checkIdleTimeout("255", 251_000, [])).toThrow("Set CONNECTION_IDLE_TIMEOUT to 0");
  });

  it("refuses to load when CONNECTION_IDLE_TIMEOUT cannot cover a route's deadline", async () => {
    vi.stubEnv("CONNECTION_IDLE_TIMEOUT", "35");
    await expect(proxyWithTimeouts([{ pathPrefix: "/api/file-transfers/", timeoutMs: null }])).rejects.toThrow(
      "CONNECTION_IDLE_TIMEOUT=35 lets the web server close a silent connection",
    );
    vi.stubEnv("CONNECTION_IDLE_TIMEOUT", "0");
    await expect(proxyWithTimeouts([{ pathPrefix: "/api/file-transfers/", timeoutMs: null }])).resolves.toBeDefined();
  });

  it("refuses to load with an invalid application timeout", async () => {
    await expect(proxyWithTimeouts([{ pathPrefix: "/api/exports", timeoutMs: -1 }])).rejects.toThrow(
      "APP_PROXY_TIMEOUTS timeoutMs for /api/exports must be null",
    );
  });
});
