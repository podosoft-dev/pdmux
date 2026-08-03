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
}): RateLimitRequest {
  const headers: Record<string, string> = {};
  if (input?.apiKey) headers["x-api-key"] = input.apiKey;
  if (input?.forwarded) headers["x-forwarded-for"] = input.forwarded;
  return {
    headers,
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
});
