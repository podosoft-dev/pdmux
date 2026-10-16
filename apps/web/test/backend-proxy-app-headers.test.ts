import type { RequestEvent } from "@sveltejs/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyRequest } from "../src/lib/server/backend-proxy";
import { POST as proxyApi } from "../src/routes/api/[...path]/+server";
import { POST as proxyMcp } from "../src/routes/mcp/+server";

/**
 * pdmux's own header names live in the app-owned `proxy-headers.ts`, not in the
 * managed lists of `backend-proxy.ts`: `podo update` restores those lists, so a
 * name kept there disappears on the next update with nothing failing. This runs
 * the real proxy with the real lists — no module mock — so dropping a name from
 * `proxy-headers.ts` fails here.
 */
describe("[TC-PDMCP-062] the web proxy carries what MCP and resumable transfers need", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A route event for a request that adapter-bun has already put on the public origin. */
  const event = (request: Request): RequestEvent =>
    ({ request, url: new URL(request.url), getClientAddress: () => "203.0.113.7" }) as unknown as RequestEvent;

  it("forwards the app's request headers and the origin the caller reached, and drops the rest", async () => {
    let sent: Headers | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    });
    const request = new Request("https://dash.example.com/mcp", {
      method: "POST",
      body: "{}",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
        "mcp-session-id": "session-1",
        "last-event-id": "41",
        "content-range": "bytes 0-9/10",
        "x-unlisted": "dropped",
        // A caller cannot choose the origin the API hands out.
        "x-pdmux-caller-origin": "https://evil.example.com",
      },
    });
    await proxyMcp(event(request));

    expect(sent?.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(sent?.get("mcp-session-id")).toBe("session-1");
    expect(sent?.get("last-event-id")).toBe("41");
    expect(sent?.get("content-range")).toBe("bytes 0-9/10");
    // The MCP install command is built from this; without it the API names its
    // own container, an address that resolves nowhere outside the network.
    expect(sent?.get("x-pdmux-caller-origin")).toBe("https://dash.example.com");
    expect(sent?.has("x-unlisted")).toBe(false);

    await proxyApi(event(new Request("http://box.lan:5001/api/mcp/keys", { method: "POST", body: "{}" })));
    expect(sent?.get("x-pdmux-caller-origin")).toBe("http://box.lan:5001");
  });

  it("relays the app's response headers", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response("{}", {
        status: 401,
        headers: {
          "mcp-protocol-version": "2025-06-18",
          "mcp-session-id": "session-1",
          "www-authenticate": 'Bearer realm="pdmux"',
          "x-accel-buffering": "no",
          "ratelimit-reset": "30",
          "x-unlisted": "dropped",
        },
      }),
    );
    const response = await proxyRequest(new Request("https://dash.example.com/mcp"), "http://api:5002/mcp");

    expect(response.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(response.headers.get("mcp-session-id")).toBe("session-1");
    // How an MCP client learns it has to present a key at all.
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="pdmux"');
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("ratelimit-reset")).toBe("30");
    expect(response.headers.has("x-unlisted")).toBe(false);
  });
});
