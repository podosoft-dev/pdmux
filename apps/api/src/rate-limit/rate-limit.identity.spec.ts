import { describe, expect, mock, test } from "bun:test";
import { ApiKeyVerifier } from "../api-key/api-key-verifier";
import {
  REQUEST_IDENTITY,
  ServiceRegistry,
} from "../core/services";
import {
  RATE_LIMIT_IDENTITY_EXTENSION,
  RateLimitIdentity,
  RateLimitIdentityExtension,
} from "./rate-limit.identity";

const proxyConfig = { proxyHeader: "x-forwarded-for", trustedProxyHops: 1 };

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/ordinary", { headers });
}

function services(userId?: string): ServiceRegistry {
  const registry = new ServiceRegistry();
  registry.register(REQUEST_IDENTITY, { userId: async () => userId });
  return registry;
}

describe("RateLimitIdentity", () => {
  test("uses an authenticated user without exposing the user id", async () => {
    const verifier = { isValid: mock(() => true) } as unknown as ApiKeyVerifier;
    const identity = new RateLimitIdentity(verifier, services("user-secret-id"));
    const value = await identity.resolve(
      request({ "x-api-key": "api-secret" }),
      "10.0.0.9",
      proxyConfig,
    );
    expect(value).toMatch(/^user:[a-f0-9]{64}$/);
    expect(value).not.toContain("user-secret-id");
    expect(verifier.isValid).not.toHaveBeenCalled();
  });

  test("uses configured and extension API keys without storing raw keys", async () => {
    const registry = services();
    class Extension extends RateLimitIdentityExtension {
      async validatedApiKeyId(_request: Request, rawApiKey: string): Promise<string | undefined> {
        return rawApiKey === "external-valid" ? "external-stable-id" : undefined;
      }
    }
    registry.register(RATE_LIMIT_IDENTITY_EXTENSION, new Extension());
    const verifier = {
      isValid: mock((value: string) => value === "configured-valid"),
    } as unknown as ApiKeyVerifier;
    const identity = new RateLimitIdentity(verifier, registry);

    for (const raw of ["configured-valid", "external-valid"]) {
      const value = await identity.resolve(request({ "x-api-key": raw }), "10.0.0.9", proxyConfig);
      expect(value).toMatch(/^api-key:[a-f0-9]{64}$/);
      expect(value).not.toContain(raw);
    }
  });

  test("falls back to the trusted client address", async () => {
    const identity = new RateLimitIdentity(
      { isValid: mock(() => false) } as unknown as ApiKeyVerifier,
      services(),
    );
    const value = await identity.resolve(
      request({ "x-forwarded-for": "203.0.113.7" }),
      "10.0.0.9",
      proxyConfig,
    );
    expect(value).toMatch(/^ip:[a-f0-9]{64}$/);
    expect(value).not.toContain("203.0.113.7");
  });
});
