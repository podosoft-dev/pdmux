import { describe, expect, mock, test } from "bun:test";
import type { RequestGuardContext } from "../core/services";
import type { RateLimitIdentity } from "./rate-limit.identity";
import { RateLimiter, type RateLimitStorage } from "./rate-limit.module";

const config = {
  keyPrefix: "podokit:test:rate-limit",
  ttlSeconds: 60,
  limit: 300,
  authTtlSeconds: 60,
  authLimit: 20,
  runtimeLimit: 1000,
  trustedProxyHops: 0,
  proxyHeader: "x-forwarded-for",
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
      remoteAddress: "127.0.0.1",
      setHeader: (name, value) => { headers[name.toLowerCase()] = value; },
    },
  };
}

describe("RateLimiter", () => {
  test("applies general, authentication, and runtime profiles", async () => {
    const increment = mock(async (_key: string, _ttlSeconds: number) => ({
      count: 1,
      retryAfterSeconds: 60,
    }));
    const limiter = new RateLimiter(
      config,
      { resolve: async () => "user:test" } as unknown as RateLimitIdentity,
      { increment } as RateLimitStorage,
    );
    await limiter.enforce(context("/ordinary").value);
    await limiter.enforce(context("/api/auth/sign-in", "POST").value);
    await limiter.enforce(context("/site/settings").value);

    expect(increment.mock.calls.map((call) => call.slice(1))).toEqual([
      [60],
      [60],
      [60],
    ]);
    expect(increment.mock.calls.map((call) => call[0])).toEqual([
      "podokit:test:rate-limit:general:user:test",
      "podokit:test:rate-limit:auth:user:test",
      "podokit:test:rate-limit:runtime:user:test",
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
      { resolve: async () => "user:test" } as unknown as RateLimitIdentity,
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
