import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyRequest, resolveClientIp } from "./backend-proxy";

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
});
