import { describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { ApiKeyVerifier } from "../api-key/api-key-verifier";
import { RESOLVED_SESSIONS, ResolvedSessions, ServiceRegistry, type RequestGuardContext } from "../core/services";
import { RateLimitIdentity, SessionUsers } from "./rate-limit.identity";
import { CacheRateLimitStorage, RateLimiter, type RateLimitStorage } from "./rate-limit.module";
import { MemoryCacheStore } from "@podosoft/podokit-runtime";

const config = {
  keyPrefix: "podokit:test:rate-limit",
  ttlSeconds: 60,
  limit: 300,
  authTtlSeconds: 60,
  authLimit: 20,
  runtimeLimit: 1000,
  storageTimeoutMs: 100,
  unavailableRetryAfterSeconds: 1,
};

function context(path: string, method = "GET"): {
  value: RequestGuardContext;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  return {
    headers,
    value: {
      request: new Request(`http://localhost${path}`, { method }),
      clientAddress: "127.0.0.1",
      setHeader: (name, value) => { headers[name.toLowerCase()] = value; },
    },
  };
}

describe("RateLimiter per-user budgets", () => {
  const secret = "rate-limit-test-secret-with-at-least-32-characters";
  const signed = (token: string): string =>
    `${token}.${createHmac("sha256", secret).update(token).digest("base64")}`;

  test("draws a user's sessions from one budget and another user's from its own", async () => {
    const services = new ServiceRegistry();
    services.register(RESOLVED_SESSIONS, new ResolvedSessions());
    const users = new SessionUsers();
    services.resolve(RESOLVED_SESSIONS).listen(({ token, userId, expiresAt }) => users.remember(token, userId, expiresAt));
    const limiter = new RateLimiter(
      config,
      new RateLimitIdentity({ isValid: () => false } as unknown as ApiKeyVerifier, services, secret, users),
      new CacheRateLimitStorage(new MemoryCacheStore()),
    );
    const expiresAt = new Date(Date.now() + 60_000);
    for (const [token, userId] of [["laptop", "user-1"], ["phone", "user-1"], ["other", "user-2"]] as const) {
      services.resolve(RESOLVED_SESSIONS).report({ token, userId, expiresAt });
    }
    const remaining = async (token: string): Promise<string | undefined> => {
      const headers: Record<string, string> = {};
      await limiter.enforce({
        request: new Request("http://localhost/ordinary", { headers: { authorization: `Bearer ${signed(token)}` } }),
        clientAddress: "127.0.0.1",
        setHeader: (name, value) => { headers[name.toLowerCase()] = value; },
      });
      return headers["ratelimit-remaining"];
    };

    expect(await remaining("laptop")).toBe("299");
    expect(await remaining("phone")).toBe("298");
    expect(await remaining("laptop")).toBe("297");
    expect(await remaining("other")).toBe("299");
    // A session the API has not resolved yet keeps a counter of its own.
    expect(await remaining("tablet")).toBe("299");
  });
});

describe("RateLimiter", () => {
  test("uses the selected cache fixed-window primitive", async () => {
    let now = 1_000;
    const storage = new CacheRateLimitStorage(new MemoryCacheStore({ now: () => now }));
    expect(await storage.increment("user", 60)).toMatchObject({ count: 1 });
    expect(await storage.increment("user", 60)).toMatchObject({ count: 2 });
    now += 60_000;
    expect(await storage.increment("user", 60)).toMatchObject({ count: 1 });
  });

  test("applies general, authentication, and runtime profiles", async () => {
    const increment = mock(async (_key: string, _ttlSeconds: number) => ({
      count: 1,
      retryAfterSeconds: 60,
    }));
    const limiter = new RateLimiter(
      config,
      { resolve: async () => "session:test" } as unknown as RateLimitIdentity,
      { increment } as RateLimitStorage,
    );
    await limiter.enforce(context("/ordinary").value);
    await limiter.enforce(context("/api/auth/sign-in", "POST").value);
    await limiter.enforce(context("/api/auth/get-session").value);
    await limiter.enforce(context("/site/settings").value);
    await limiter.enforce(context("/api/auth/admin/list-users").value);
    await limiter.enforce(context("/api/auth/admin/ban-user", "POST").value);

    expect(increment.mock.calls.map((call) => call.slice(1))).toEqual([
      [60],
      [60],
      [60],
      [60],
      [60],
      [60],
    ]);
    expect(increment.mock.calls.map((call) => call[0])).toEqual([
      "podokit:test:rate-limit:general:session:test",
      "podokit:test:rate-limit:auth:session:test",
      "podokit:test:rate-limit:runtime:session:test",
      "podokit:test:rate-limit:runtime:session:test",
      "podokit:test:rate-limit:general:session:test",
      "podokit:test:rate-limit:auth:session:test",
    ]);
  });

  test("bypasses health probes and API documentation", async () => {
    const increment = mock(async (_key: string, _ttlSeconds: number) => ({
      count: 1,
      retryAfterSeconds: 60,
    }));
    const limiter = new RateLimiter(
      config,
      { resolve: async () => "ip:test" } as unknown as RateLimitIdentity,
      { increment },
    );
    await limiter.enforce(context("/health").value);
    await limiter.enforce(context("/health/ready").value);
    await limiter.enforce(context("/api-docs").value);
    await limiter.enforce(context("/api-docs-json").value);
    await limiter.enforce(context("/api-docs-elysia-json").value);
    expect(increment).not.toHaveBeenCalled();
  });

  test("returns stable blocked and storage errors with retry headers", async () => {
    const identity = { resolve: async () => "ip:test" } as unknown as RateLimitIdentity;
    const blockedContext = context("/ordinary");
    const blocked = new RateLimiter(config, identity, {
      increment: async () => ({ count: 301, retryAfterSeconds: 7 }),
    });
    await expect(blocked.enforce(blockedContext.value)).rejects.toMatchObject({
      code: "RATE_LIMIT_EXCEEDED",
      statusCode: 429,
    });
    expect(blockedContext.headers["retry-after"]).toBe("7");

    const failedContext = context("/ordinary");
    const failed = new RateLimiter(config, identity, {
      increment: async () => { throw new Error("Redis unavailable"); },
    });
    await expect(failed.enforce(failedContext.value)).rejects.toMatchObject({
      code: "RATE_LIMIT_UNAVAILABLE",
      statusCode: 503,
    });
    expect(failedContext.headers["retry-after"]).toBe("1");

    const identityContext = context("/ordinary");
    const failedIdentity = new RateLimiter(
      config,
      { resolve: async () => { throw new Error("Identity unavailable"); } } as unknown as RateLimitIdentity,
      { increment: async () => ({ count: 1, retryAfterSeconds: 60 }) },
    );
    await expect(failedIdentity.enforce(identityContext.value)).rejects.toMatchObject({
      code: "RATE_LIMIT_UNAVAILABLE",
      statusCode: 503,
    });
    expect(identityContext.headers["retry-after"]).toBe("1");
  });

  test("enforces module-specific profiles with the shared atomic storage", async () => {
    const increment = mock(async (_key: string, _ttlSeconds: number) => ({
      count: 2,
      retryAfterSeconds: 3600,
    }));
    const limiter = new RateLimiter(
      config,
      { resolve: async () => "session:test" } as unknown as RateLimitIdentity,
      { increment },
    );
    const headers: Record<string, string> = {};

    await limiter.enforceCustom(
      "blog-create",
      "author-hash",
      3600,
      3,
      (name, value) => { headers[name.toLowerCase()] = value; },
    );

    expect(increment).toHaveBeenCalledWith(
      "podokit:test:rate-limit:blog-create:author-hash",
      3600,
    );
    expect(headers["ratelimit-remaining"]).toBe("1");
  });
});
