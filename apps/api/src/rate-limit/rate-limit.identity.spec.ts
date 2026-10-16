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
  SessionUsers,
  verifiedSessionToken,
} from "./rate-limit.identity";

// The address the API resolved for the request (see core/client-address.ts).
const clientAddress = "203.0.113.7";
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
      clientAddress,
    );

    expect(value).toMatch(/^session:[a-f0-9]{64}$/);
    expect(value).not.toContain(sessionToken);
    expect(userId).not.toHaveBeenCalled();
  });

  test("gives one session the same counter across cookie names and bearer forms", async () => {
    const identity = new RateLimitIdentity(rejectingVerifier(), new ServiceRegistry(), secret);
    const value = signed(sessionToken);
    const resolved = await Promise.all([
      identity.resolve(request({ cookie: sessionCookie(value) }), clientAddress),
      identity.resolve(
        request({ cookie: sessionCookie(value, "__Secure-better-auth.session_token") }),
        clientAddress,
      ),
      identity.resolve(request({ authorization: `Bearer ${value}` }), clientAddress),
      identity.resolve(
        request({ authorization: `bearer ${encodeURIComponent(value)}` }),
        clientAddress,
      ),
    ]);
    expect(new Set(resolved).size).toBe(1);

    const other = await identity.resolve(
      request({ cookie: sessionCookie(signed("AnotherSessionToken0123456789abcd")) }),
      clientAddress,
    );
    expect(other).toMatch(/^session:/);
    expect(other).not.toBe(resolved[0]);
  });

  test("counts forged, tampered, and unsigned session values by client address", async () => {
    const identity = new RateLimitIdentity(rejectingVerifier(), new ServiceRegistry(), secret);
    const address = { "x-forwarded-for": "203.0.113.7" };
    const anonymous = await identity.resolve(request(address), clientAddress);
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
          clientAddress,
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
        clientAddress,
      );
      expect(value).toMatch(/^api-key:[a-f0-9]{64}$/);
      expect(value).not.toContain(raw);
    }

    const invalidKey = await identity.resolve(
      request({ "x-api-key": "invalid", cookie }),
      clientAddress,
    );
    expect(invalidKey).toMatch(/^session:/);
  });

  test("falls back to the trusted client address without authentication", async () => {
    const cookie = sessionCookie(signed(sessionToken));
    // No session secret: the auth module is not installed or not configured.
    const identity = new RateLimitIdentity(rejectingVerifier(), new ServiceRegistry(), undefined);
    const value = await identity.resolve(
      request({ "x-forwarded-for": "203.0.113.7", cookie }),
      clientAddress,
    );
    expect(value).toMatch(/^ip:[a-f0-9]{64}$/);
    expect(value).not.toContain("203.0.113.7");
    expect(
      await identity.resolve(request({ "x-forwarded-for": "203.0.113.7" }), clientAddress),
    ).toBe(value);
  });
});

describe("RateLimitIdentity per user", () => {
  const otherToken = "AnotherSessionToken0123456789abcd";
  const thirdToken = "ThirdSessionToken0123456789abcdef";
  const resolveWith = (identity: RateLimitIdentity, headers: Record<string, string>): Promise<string> =>
    identity.resolve(request({ "x-forwarded-for": "203.0.113.7", ...headers }), clientAddress);

  test("counts every session of a user under one counter once the API resolved them", async () => {
    let now = 1_000;
    const users = new SessionUsers(100, () => now);
    const identity = new RateLimitIdentity(rejectingVerifier(), new ServiceRegistry(), secret, users);
    const first = { cookie: sessionCookie(signed(sessionToken)) };
    const second = { authorization: `Bearer ${signed(otherToken)}` };

    // Before the API resolves a session, it keeps a counter of its own.
    const unresolved = await resolveWith(identity, first);
    expect(unresolved).toMatch(/^session:[a-f0-9]{64}$/);

    users.remember(sessionToken, "user-1", new Date(now + 60_000));
    users.remember(otherToken, "user-1", new Date(now + 60_000));
    users.remember(thirdToken, "user-2", new Date(now + 60_000));
    const userCounter = await resolveWith(identity, first);
    expect(userCounter).toMatch(/^user:[a-f0-9]{64}$/);
    expect(userCounter).not.toContain("user-1");
    expect(await resolveWith(identity, second)).toBe(userCounter);
    expect(await resolveWith(identity, { cookie: sessionCookie(signed(thirdToken)) })).not.toBe(userCounter);

    // The entry lasts until the session expires.
    now += 60_000;
    expect(await resolveWith(identity, first)).toBe(unresolved);
  });

  test("keeps API keys first and forged sessions on the client address", async () => {
    const users = new SessionUsers();
    users.remember(sessionToken, "user-1", new Date(Date.now() + 60_000));
    const verifier = { isValid: mock((value: string) => value === "configured-valid") } as unknown as ApiKeyVerifier;
    const identity = new RateLimitIdentity(verifier, new ServiceRegistry(), secret, users);
    const cookie = sessionCookie(signed(sessionToken));

    expect(await resolveWith(identity, { "x-api-key": "configured-valid", cookie })).toMatch(/^api-key:/);
    expect(await resolveWith(identity, { cookie: sessionCookie(tamperedSignature(signed(sessionToken))) }))
      .toBe(await resolveWith(identity, {}));
    expect(await resolveWith(identity, {})).toMatch(/^ip:/);
  });
});

describe("SessionUsers", () => {
  test("ignores an expired session and forgets the oldest past its bound", () => {
    let now = 1_000;
    const users = new SessionUsers(2, () => now);
    users.remember("expired", "user-0", new Date(now));
    expect(users.userOf("expired")).toBeUndefined();

    users.remember("a", "user-a", new Date(now + 10_000));
    users.remember("b", "user-b", new Date(now + 10_000));
    users.remember("a", "user-a", new Date(now + 20_000));
    users.remember("c", "user-c", new Date(now + 10_000));
    // "a" was refreshed, so "b" was the oldest.
    expect(users.userOf("a")).toBe("user-a");
    expect(users.userOf("b")).toBeUndefined();
    expect(users.userOf("c")).toBe("user-c");

    now += 10_000;
    expect(users.userOf("c")).toBeUndefined();
    expect(users.userOf("a")).toBe("user-a");
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
