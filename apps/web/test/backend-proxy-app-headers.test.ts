import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyRequest } from "../src/lib/server/backend-proxy";

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
      },
    });
    await proxyRequest(request, "http://api:5002/mcp");

    expect(sent?.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(sent?.get("mcp-session-id")).toBe("session-1");
    expect(sent?.get("last-event-id")).toBe("41");
    expect(sent?.get("content-range")).toBe("bytes 0-9/10");
    // The MCP install command is built from these; without them it names the
    // API's container, an address that resolves nowhere outside the network.
    expect(sent?.get("x-forwarded-host")).toBe("dash.example.com");
    expect(sent?.get("x-forwarded-proto")).toBe("https");
    expect(sent?.has("x-unlisted")).toBe(false);
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
