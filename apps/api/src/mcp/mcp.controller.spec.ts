import { describe, expect, it, jest } from "@jest/globals";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { Request, Response } from "express";

import { McpController } from "./mcp.controller";
import { resetMcpEnabledCache } from "./mcp-enabled";
import type { McpAuthService } from "./mcp-auth.service";
import type { McpIdentity } from "./host-mcp-keys.service";
import type { FleetSettingsService } from "../fleet/fleet-settings.service";
import type { HostsService } from "../hosts/hosts.service";

/**
 * The kill switch reads `app_setting` through a short-TTL pool query rather than
 * through `SettingsService` — because that service caches PER PROCESS and a switch
 * that only works on the replica that handled the toggle is not a switch. Mocking
 * the pool is how a unit test reaches it.
 */
jest.mock("../auth/db", () => ({ pool: { query: jest.fn(async () => ({ rows: [{ value: "true" }] })) } }));
import { pool } from "../auth/db";

function setMcpEnabled(value: boolean | "unreadable"): void {
  resetMcpEnabledCache();
  const query = pool.query as unknown as jest.Mock<() => Promise<{ rows: { value: string }[] }>>;
  query.mockImplementation(async () => {
    if (value === "unreadable") throw new Error("database is having a moment");
    return { rows: [{ value: String(value) }] };
  });
}

/**
 * The check order at the front of `/mcp`.
 *
 * WHY THIS FILE EXISTS: `mcp.controller.ts` has claimed since it was written that
 * "there is a unit test for the ordering, because it is exactly the kind of thing a
 * later refactor tidies away". There was not. The comment described an intention;
 * this file is the thing that keeps it.
 *
 * ⚠ THE ASSERTIONS THAT MATTER ARE THE NEGATIVE ONES. That a cross-origin request
 * gets a 403 is easy and nearly meaningless on its own — a controller that read the
 * key first and *then* checked the origin would pass it. What the contract actually
 * says is that the credential is NEVER LOOKED AT, so the response cannot depend on
 * whether the key was real. `expect(keys.authenticate).not.toHaveBeenCalled()` is
 * that sentence, and it is the one that fails when somebody reorders the method.
 */

const IDENTITY: McpIdentity = {
  keyId: "key-1",
  hostId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-a",
  scopes: ["read", "write"],
};

/** Only the headers the controller reads; anything else is not part of the contract. */
type Headers = Partial<Record<"origin" | "host" | "x-forwarded-host" | "x-forwarded-proto" | "authorization", string>>;

function fakeRequest(method: string, headers: Headers): Request {
  return {
    method,
    protocol: "http",
    body: {},
    header: (name: string) => headers[name.toLowerCase() as keyof Headers],
  } as unknown as Request;
}

function fakeResponse() {
  const headers = new Map<string, string>();
  const sent: { status?: number; body?: unknown } = {};
  const response = {
    setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
    status: (code: number) => {
      sent.status = code;
      return { json: (body: unknown) => void (sent.body = body) };
    },
    on: () => undefined,
  } as unknown as Response;
  return { response, headers, sent };
}

function context(identity: McpIdentity | null = IDENTITY) {
  setMcpEnabled(true);
  const keys = {
    authenticate: jest.fn<(presented: string) => Promise<{ kind: "host"; identity: McpIdentity } | null>>(
      async () => (identity ? { kind: "host", identity } : null),
    ),
  };
  // A sentinel rather than a host row: reaching this call is the only thing the
  // last test needs to observe, and building a real MCP server to see it would
  // drag a transport into a spec about four `if` statements.
  const reachedHostLookup = new Error("REACHED_HOST_LOOKUP");
  const hosts = { get: jest.fn<() => Promise<never>>(async () => { throw reachedHostLookup; }) };
  const fleetSettings = { resolve: jest.fn(async () => ({ mcpUserTokens: true })) };
  const controller = new McpController(
    keys as unknown as McpAuthService,
    hosts as unknown as HostsService,
    fleetSettings as unknown as FleetSettingsService,
    ...(Array(6).fill(undefined) as [never, never, never, never, never, never]),
  );
  return { controller, keys, hosts, fleetSettings, reachedHostLookup };
}

describe("[TC-PDMCP-060] the origin is settled before the credential is read", () => {
  it("[TC-PDMCP-060] refuses a mismatched origin without touching the key", async () => {
    const { controller, keys } = context();
    const { response } = fakeResponse();

    await expect(
      controller.handle(
        fakeRequest("POST", { origin: "https://evil.example", host: "pdmux.example.com", authorization: "Bearer pdmux_mcp_whatever" }),
        response,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // The whole point. A key was presented and was never looked up, so the answer
    // cannot leak whether it was a real one.
    expect(keys.authenticate).not.toHaveBeenCalled();
  });

  it("[TC-PDMCP-060] treats an unparseable origin as not same-origin, still without the key", async () => {
    const { controller, keys } = context();
    const { response } = fakeResponse();

    await expect(
      controller.handle(
        fakeRequest("POST", { origin: "not a url", host: "pdmux.example.com", authorization: "Bearer pdmux_mcp_whatever" }),
        response,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(keys.authenticate).not.toHaveBeenCalled();
  });

  it("[TC-PDMCP-060] lets a client that sends no origin through — that is the normal case", async () => {
    const { controller, keys, reachedHostLookup } = context();
    const { response } = fakeResponse();

    // A CLI sends no `Origin`. It must reach the credential check rather than being
    // refused for the header a browser would have sent.
    await expect(
      controller.handle(fakeRequest("POST", { host: "pdmux.example.com", authorization: "Bearer pdmux_mcp_good" }), response),
    ).rejects.toBe(reachedHostLookup);
    expect(keys.authenticate).toHaveBeenCalledWith("pdmux_mcp_good");
  });

  it("[TC-PDMCP-060] accepts an origin that matches the forwarded host, not just the socket host", async () => {
    const { controller, keys, reachedHostLookup } = context();
    const { response } = fakeResponse();

    // Behind a reverse proxy `host` is the container's name; the browser's origin
    // matches `x-forwarded-host`. Comparing against `host` alone would 403 every
    // same-origin request in a real deployment.
    await expect(
      controller.handle(
        fakeRequest("POST", {
          origin: "https://pdmux.example.com",
          host: "pdmux-api:3000",
          "x-forwarded-host": "pdmux.example.com",
          authorization: "Bearer pdmux_mcp_good",
        }),
        response,
      ),
    ).rejects.toBe(reachedHostLookup);
    expect(keys.authenticate).toHaveBeenCalledTimes(1);
  });
});

describe("[TC-PDMCP-060] a request without a usable credential is told to send one", () => {
  it("[TC-PDMCP-060] answers 401 with www-authenticate when no key is presented", async () => {
    const { controller, keys } = context();
    const { response, headers } = fakeResponse();

    await expect(
      controller.handle(fakeRequest("POST", { host: "pdmux.example.com" }), response),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // The header is what makes a client ask for a key instead of giving up.
    expect(headers.get("www-authenticate")).toBe('Bearer realm="pdmux-mcp"');
    // No bearer at all means there is nothing to look up.
    expect(keys.authenticate).not.toHaveBeenCalled();
  });

  it("[TC-PDMCP-060] answers 401 the same way for a key the service does not recognise", async () => {
    const { controller } = context(null);
    const { response, headers } = fakeResponse();

    await expect(
      controller.handle(
        fakeRequest("POST", { host: "pdmux.example.com", authorization: "Bearer pdmux_mcp_revoked" }),
        response,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(headers.get("www-authenticate")).toBe('Bearer realm="pdmux-mcp"');
  });

  it("[TC-PDMCP-060] ignores an Authorization header that is not a bearer", async () => {
    const { controller, keys } = context();
    const { response } = fakeResponse();

    await expect(
      controller.handle(
        fakeRequest("POST", { host: "pdmux.example.com", authorization: "Basic dXNlcjpwYXNz" }),
        response,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(keys.authenticate).not.toHaveBeenCalled();
  });
});

describe("[TC-PDMCP-060] a stateless endpoint accepts POST only", () => {
  it.each(["GET", "DELETE"])("[TC-PDMCP-060] answers %s with 405 and a JSON-RPC body", async (method) => {
    const { controller, hosts } = context();
    const { response, headers, sent } = fakeResponse();

    await controller.handle(
      fakeRequest(method, { host: "pdmux.example.com", authorization: "Bearer pdmux_mcp_good" }),
      response,
    );

    expect(sent.status).toBe(405);
    expect(headers.get("allow")).toBe("POST");
    // A JSON-RPC client parses the body; an HTML error page or a bare status makes
    // it report a transport failure instead of the reason.
    expect(sent.body).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 }, id: null });
    // 405 is decided after the credential, so nothing further runs.
    expect(hosts.get).not.toHaveBeenCalled();
  });
});

describe("[TC-PDMCP-060] an authenticated POST resolves the host the key is bound to", () => {
  it("[TC-PDMCP-060] looks the host up in the scope the key resolved to", async () => {
    const { controller, hosts, reachedHostLookup } = context();
    const { response } = fakeResponse();

    await expect(
      controller.handle(
        fakeRequest("POST", { host: "pdmux.example.com", authorization: "Bearer pdmux_mcp_good" }),
        response,
      ),
    ).rejects.toBe(reachedHostLookup);

    // Both arguments come from the identity, never from the request body — that is
    // what stops a caller naming another machine.
    expect(hosts.get).toHaveBeenCalledWith(IDENTITY.organizationId, IDENTITY.hostId);
  });
});

describe("the installation's kill switch", () => {
  /**
   * ⚠ THE ASSERTION THAT MAKES THE SWITCH A SWITCH. It sits above the credential
   * precisely so a disabled endpoint answers every caller identically — if it were
   * read after the key, whether MCP is on would leak through the difference between
   * a valid and an invalid credential.
   */
  it("refuses before the credential is read", async () => {
    const { controller, keys } = context();
    setMcpEnabled(false);
    const { response, headers, sent } = fakeResponse();

    await controller.handle(
      fakeRequest("POST", { host: "pdmux.example.com", authorization: "Bearer pdmux_mcp_good" }),
      response,
    );

    expect(sent.status).toBe(404);
    expect(keys.authenticate).not.toHaveBeenCalled();
    // ⚠ NO `www-authenticate`. With it, a client reads "send me a key", retries for
    // ever, and the operator debugs a credential problem that does not exist.
    expect(headers.has("www-authenticate")).toBe(false);
    expect(sent.body).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 }, id: null });
  });

  it("still refuses the origin first", async () => {
    const { controller } = context();
    setMcpEnabled(false);
    const { response } = fakeResponse();

    // Turning MCP off must not turn the origin check off with it.
    await expect(
      controller.handle(
        fakeRequest("POST", { origin: "https://evil.example", host: "pdmux.example.com" }),
        response,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  /**
   * ⚠ FAILS OPEN, AND ON PURPOSE. A database blip must not read as "every coding CLI
   * in the fleet is broken". Turning MCP off is a deliberate act; a failed read is
   * not one, and `TwoFactorRequiredGuard` fails the same direction for the same
   * reason.
   */
  it("keeps serving when the setting cannot be read", async () => {
    const { controller, keys } = context();
    setMcpEnabled("unreadable");
    const { response } = fakeResponse();

    await expect(
      controller.handle(
        fakeRequest("POST", { host: "pdmux.example.com", authorization: "Bearer pdmux_mcp_good" }),
        response,
      ),
    ).rejects.toBeTruthy();
    expect(keys.authenticate).toHaveBeenCalled();
  });
});

describe("the per-fleet switch for fleet-wide tokens", () => {
  /**
   * ⚠ THE ASYMMETRY IS THE WHOLE POINT OF HAVING TWO SWITCHES. `mcpUserTokens` is
   * about the NEW credential shape; a host key must keep working whatever it says,
   * or turning it off would break coding CLIs that have nothing to do with it.
   */
  it("does not touch a host-scoped key", async () => {
    const { controller, hosts, fleetSettings, reachedHostLookup } = context();
    fleetSettings.resolve.mockResolvedValue({ mcpUserTokens: false });
    const { response } = fakeResponse();

    await expect(
      controller.handle(
        fakeRequest("POST", { host: "pdmux.example.com", authorization: "Bearer pdmux_mcp_good" }),
        response,
      ),
    ).rejects.toBe(reachedHostLookup);
    expect(hosts.get).toHaveBeenCalled();
    // A host key never asks the question, so it never pays for the read either.
    expect(fleetSettings.resolve).not.toHaveBeenCalled();
  });
});
