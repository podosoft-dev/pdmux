import { describe, expect, it, jest } from "@jest/globals";
import type { Request } from "express";
import type { ModuleRef } from "@nestjs/core";
import type { ApiKeyVerifier } from "../api-key/api-key-verifier";

jest.mock("../auth/auth-provider", () => ({
  authRuntime: { api: { getSession: jest.fn() } },
}));
jest.mock("better-auth/node", () => ({
  fromNodeHeaders: (headers: unknown) => headers,
}));

import { authRuntime } from "../auth/auth-provider";
import {
  RateLimitIdentity,
  RateLimitIdentityExtension,
  type RateLimitRequest,
} from "./rate-limit.identity";

function testRequest(input?: {
  session?: RateLimitRequest["session"];
  apiKey?: string;
  forwarded?: string;
  remoteAddress?: string;
  path?: string;
  bearer?: string;
}): RateLimitRequest {
  const headers: Record<string, string> = {};
  if (input?.apiKey) headers["x-api-key"] = input.apiKey;
  if (input?.forwarded) headers["x-forwarded-for"] = input.forwarded;
  if (input?.bearer) headers["authorization"] = `Bearer ${input.bearer}`;
  return {
    headers,
    path: input?.path ?? "/hosts",
    header: (name: string) => headers[name.toLowerCase()],
    socket: { remoteAddress: input?.remoteAddress ?? "10.0.0.9" },
    ip: input?.remoteAddress ?? "10.0.0.9",
    ...(input && "session" in input ? { session: input.session } : {}),
  } as unknown as Request & RateLimitRequest;
}

const proxyConfig = {
  proxyHeader: "x-forwarded-for",
  trustedProxyHops: 1,
};

class ApplicationIdentityExtension extends RateLimitIdentityExtension {
  override async validatedApiKeyId(
    _request: RateLimitRequest,
    rawApiKey: string,
  ): Promise<string | undefined> {
    return rawApiKey === "external-valid" ? "external-stable-id" : undefined;
  }
}

describe("RateLimitIdentity", () => {
  it("uses an attached user before API key or IP without exposing the user id", async () => {
    const verifier = { isValid: jest.fn(() => true) };
    const identity = new RateLimitIdentity(verifier as unknown as ApiKeyVerifier);
    const request = testRequest({
      session: { user: { id: "user-secret-id" } },
      apiKey: "api-secret",
      forwarded: "203.0.113.7",
    });

    const first = await identity.resolve(request, proxyConfig);
    const second = await identity.resolve(request, proxyConfig);

    expect(first).toBe(second);
    expect(first).toMatch(/^user:[a-f0-9]{64}$/);
    expect(first).not.toContain("user-secret-id");
    expect(verifier.isValid).not.toHaveBeenCalled();
  });

  it("resolves a session when a preceding auth guard has not attached one", async () => {
    const session = {
      user: { id: "resolved-user", email: "user@example.com", name: "User" },
      session: { id: "session-id", userId: "resolved-user" },
    };
    const getSession = jest
      .spyOn(authRuntime.api, "getSession")
      .mockResolvedValue(
        session as Awaited<ReturnType<typeof authRuntime.api.getSession>>,
      );
    const identity = new RateLimitIdentity(
      { isValid: jest.fn(() => false) } as unknown as ApiKeyVerifier,
    );
    const request = testRequest();

    try {
      const value = await identity.resolve(request, proxyConfig);
      expect(value).toMatch(/^user:[a-f0-9]{64}$/);
      expect(request.session?.user?.id).toBe("resolved-user");
      expect(getSession).toHaveBeenCalledTimes(1);
    } finally {
      getSession.mockRestore();
    }
  });

  it("uses validated configured and extension API keys without storing raw keys", async () => {
    const verifier = {
      isValid: jest.fn((value: string) => value === "configured-valid"),
    } as unknown as ApiKeyVerifier;
    const extension = new ApplicationIdentityExtension();
    const moduleRef = {
      get: () => extension,
    } as unknown as ModuleRef;
    const identity = new RateLimitIdentity(verifier, moduleRef);

    for (const raw of ["configured-valid", "external-valid"]) {
      const value = await identity.resolve(
        testRequest({ session: null, apiKey: raw }),
        proxyConfig,
      );
      expect(value).toMatch(/^api-key:[a-f0-9]{64}$/);
      expect(value).not.toContain(raw);
    }
  });

  it("falls back to the trusted proxy client for an invalid API key", async () => {
    const identity = new RateLimitIdentity(
      { isValid: jest.fn(() => false) } as unknown as ApiKeyVerifier,
    );
    const request = testRequest({
      session: null,
      apiKey: "invalid-and-rotating",
      forwarded: "203.0.113.7",
    });

    const value = await identity.resolve(request, proxyConfig);

    expect(value).toMatch(/^ip:[a-f0-9]{64}$/);
    expect(value).not.toContain("invalid-and-rotating");
    expect(value).not.toContain("203.0.113.7");
  });

  /**
   * `/mcp` is the one authenticated surface with no session cookie, so before this
   * branch existed every MCP request fell through to the address bucket — and since
   * they all arrive through the web app's proxy, that was ONE bucket for the whole
   * install. A busy coding agent could 429 the dashboard.
   */
  describe("the MCP endpoint", () => {
    const identity = () =>
      new RateLimitIdentity({ isValid: jest.fn(() => false) } as unknown as ApiKeyVerifier);

    it("gives two callers behind one proxy address separate buckets", async () => {
      const one = await identity().resolve(
        testRequest({ session: null, path: "/mcp", bearer: "pdmux_mcp_aaa", forwarded: "203.0.113.7" }),
        proxyConfig,
      );
      const two = await identity().resolve(
        testRequest({ session: null, path: "/mcp", bearer: "pdmux_mcp_bbb", forwarded: "203.0.113.7" }),
        proxyConfig,
      );

      expect(one).not.toBe(two);
      expect(one).toMatch(/^api-key:[a-f0-9]{64}$/);
      expect(one).not.toContain("pdmux_mcp_aaa");
    });

    it("keeps one caller stable across requests", async () => {
      const make = () =>
        identity().resolve(
          testRequest({ session: null, path: "/mcp", bearer: "pdmux_mcp_aaa", forwarded: "203.0.113.7" }),
          proxyConfig,
        );
      expect(await make()).toBe(await make());
    });

    /**
     * ⚠ THE ASSERTION THAT KEEPS THE DESIGN HONEST. Tracking on the token alone
     * would be WORSE than tracking on the address: a sprayer would earn a fresh
     * bucket per guess and face no limit at all. The address is part of the key, so
     * rotating tokens from one place cannot escape.
     */
    it("does not let a rotating token escape its address", async () => {
      const first = await identity().resolve(
        testRequest({ session: null, path: "/mcp", bearer: "guess-1", forwarded: "203.0.113.7" }),
        proxyConfig,
      );
      const elsewhere = await identity().resolve(
        testRequest({ session: null, path: "/mcp", bearer: "guess-1", forwarded: "198.51.100.4" }),
        proxyConfig,
      );

      expect(first).not.toBe(elsewhere);
    });

    it("does not answer a bearer on any other path", async () => {
      const value = await identity().resolve(
        testRequest({ session: null, path: "/hosts", bearer: "pdmux_mcp_aaa", forwarded: "203.0.113.7" }),
        proxyConfig,
      );
      expect(value).toMatch(/^ip:[a-f0-9]{64}$/);
    });

    it("never looks for a session it could not have", async () => {
      const getSession = jest.spyOn(authRuntime.api, "getSession");
      try {
        await identity().resolve(
          testRequest({ path: "/mcp", bearer: "pdmux_mcp_aaa" }),
          proxyConfig,
        );
        // A bearer credential has no cookie, so the lookup was pure cost.
        expect(getSession).not.toHaveBeenCalled();
      } finally {
        getSession.mockRestore();
      }
    });
  });
});
