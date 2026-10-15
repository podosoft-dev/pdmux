import { createHmac } from "node:crypto";
import { describe, expect, mock, test, type Mock } from "bun:test";
import { ApiKeyVerifier } from "../api-key/api-key-verifier";
import {
  REQUEST_IDENTITY,
  ServiceRegistry,
} from "../core/services";
import {
  RATE_LIMIT_IDENTITY_EXTENSION,
  RateLimitIdentity,
  RateLimitIdentityExtension,
  verifiedSessionToken,
} from "./rate-limit.identity";

const proxyConfig = { proxyHeader: "x-forwarded-for", trustedProxyHops: 1 };
const secret = "rate-limit-test-secret-with-at-least-32-characters";
const sessionToken = "Sx0d8mFqY3KcT7wJpLr2NvBhZa9EgUi4";

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/ordinary", { headers });
}

// The same format Better Auth issues: `${token}.${base64(HMAC-SHA256)}`.
function signed(token: string, key = secret): string {
  return `${token}.${createHmac("sha256", key).update(token).digest("base64")}`;
}

function tamperedSignature(value: string): string {
  const index = value.lastIndexOf(".") + 1;
  const replacement = value[index] === "A" ? "B" : "A";
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}

function sessionCookie(value: string, name = "better-auth.session_token"): string {
  return `theme=dark; ${name}=${encodeURIComponent(value)}`;
}

function rejectingVerifier(): ApiKeyVerifier {
  return { isValid: mock(() => false) } as unknown as ApiKeyVerifier;
}

// Registers a request identity that would hit the session store, so tests can
// prove the limiter never asks for it.
function servicesWithSessionStore(): {
  registry: ServiceRegistry;
  userId: Mock<(request: Request) => Promise<string | undefined>>;
} {
  const registry = new ServiceRegistry();
  const userId = mock(async (_request: Request): Promise<string | undefined> => "user-secret-id");
  registry.register(REQUEST_IDENTITY, {
    userId,
    isAdmin: async () => false,
    roles: async () => [],
    activeOrganizationId: async () => undefined,
  });
  return { registry, userId };
}

describe("RateLimitIdentity", () => {
  test("uses a verified session cookie without resolving the session", async () => {
    const { registry, userId } = servicesWithSessionStore();
    const identity = new RateLimitIdentity(rejectingVerifier(), registry, secret);

    const value = await identity.resolve(
      request({ cookie: sessionCookie(signed(sessionToken)) }),
      "10.0.0.9",
      proxyConfig,
    );

    expect(value).toMatch(/^session:[a-f0-9]{64}$/);
    expect(value).not.toContain(sessionToken);
    expect(userId).not.toHaveBeenCalled();
  });

  test("gives one session the same counter across cookie names and bearer forms", async () => {
    const identity = new RateLimitIdentity(rejectingVerifier(), new ServiceRegistry(), secret);
    const value = signed(sessionToken);
    const resolved = await Promise.all([
      identity.resolve(request({ cookie: sessionCookie(value) }), "10.0.0.9", proxyConfig),
      identity.resolve(
        request({ cookie: sessionCookie(value, "__Secure-better-auth.session_token") }),
        "10.0.0.9",
        proxyConfig,
      ),
      identity.resolve(request({ authorization: `Bearer ${value}` }), "10.0.0.9", proxyConfig),
      identity.resolve(
        request({ authorization: `bearer ${encodeURIComponent(value)}` }),
        "10.0.0.9",
        proxyConfig,
      ),
    ]);
    expect(new Set(resolved).size).toBe(1);

    const other = await identity.resolve(
      request({ cookie: sessionCookie(signed("AnotherSessionToken0123456789abcd")) }),
      "10.0.0.9",
      proxyConfig,
    );
    expect(other).toMatch(/^session:/);
    expect(other).not.toBe(resolved[0]);
  });

  test("counts forged, tampered, and unsigned session values by client address", async () => {
    const identity = new RateLimitIdentity(rejectingVerifier(), new ServiceRegistry(), secret);
    const address = { "x-forwarded-for": "203.0.113.7" };
    const anonymous = await identity.resolve(request(address), "10.0.0.9", proxyConfig);
    expect(anonymous).toMatch(/^ip:[a-f0-9]{64}$/);

    const genuine = signed(sessionToken);
    const forgedValues = [
      signed(sessionToken, "an-attacker-chosen-secret-of-32-characters"),
      `${sessionToken}x${genuine.slice(sessionToken.length)}`,
      tamperedSignature(genuine),
      genuine.replace("=", ""),
      sessionToken,
      "",
    ];
    for (const forged of forgedValues) {
      const variants: Array<Record<string, string>> = [
        { cookie: sessionCookie(forged) },
        { authorization: `Bearer ${forged}` },
      ];
      for (const headers of variants) {
        const value = await identity.resolve(
          request({ ...address, ...headers }),
          "10.0.0.9",
          proxyConfig,
        );
        expect(value).toBe(anonymous);
      }
    }
  });

  test("checks API keys before sessions without storing raw keys", async () => {
    const registry = new ServiceRegistry();
    class Extension extends RateLimitIdentityExtension {
      async validatedApiKeyId(_request: Request, rawApiKey: string): Promise<string | undefined> {
        return rawApiKey === "external-valid" ? "external-stable-id" : undefined;
      }
    }
    registry.register(RATE_LIMIT_IDENTITY_EXTENSION, new Extension());
    const verifier = {
      isValid: mock((value: string) => value === "configured-valid"),
    } as unknown as ApiKeyVerifier;
    const identity = new RateLimitIdentity(verifier, registry, secret);
    const cookie = sessionCookie(signed(sessionToken));

    for (const raw of ["configured-valid", "external-valid"]) {
      const value = await identity.resolve(
        request({ "x-api-key": raw, cookie }),
        "10.0.0.9",
        proxyConfig,
      );
      expect(value).toMatch(/^api-key:[a-f0-9]{64}$/);
      expect(value).not.toContain(raw);
    }

    const invalidKey = await identity.resolve(
      request({ "x-api-key": "invalid", cookie }),
      "10.0.0.9",
      proxyConfig,
    );
    expect(invalidKey).toMatch(/^session:/);
  });

  test("falls back to the trusted client address without authentication", async () => {
    const cookie = sessionCookie(signed(sessionToken));
    // No session secret: the auth module is not installed or not configured.
    const identity = new RateLimitIdentity(rejectingVerifier(), new ServiceRegistry(), undefined);
    const value = await identity.resolve(
      request({ "x-forwarded-for": "203.0.113.7", cookie }),
      "10.0.0.9",
      proxyConfig,
    );
    expect(value).toMatch(/^ip:[a-f0-9]{64}$/);
    expect(value).not.toContain("203.0.113.7");
    expect(
      await identity.resolve(request({ "x-forwarded-for": "203.0.113.7" }), "10.0.0.9", proxyConfig),
    ).toBe(value);
  });
});

describe("verifiedSessionToken", () => {
  test("returns the token only for a matching signature", () => {
    expect(verifiedSessionToken(signed(sessionToken), secret)).toBe(sessionToken);
    expect(verifiedSessionToken(signed(sessionToken), `${secret}-rotated`)).toBeUndefined();
    expect(verifiedSessionToken(".", secret)).toBeUndefined();
    expect(verifiedSessionToken(`${sessionToken}.`, secret)).toBeUndefined();
  });
});
