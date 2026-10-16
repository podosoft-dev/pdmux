import { describe, expect, test } from "bun:test";
import { rateLimitConfig, sessionSigningSecret } from "./rate-limit.config";

describe("rate limit configuration", () => {
  test("validates route limits", () => {
    expect(
      rateLimitConfig({
        RATE_LIMIT_KEY_PREFIX: "podokit:tenant-a:rate-limit",
        RATE_LIMIT_TTL: "30",
        RATE_LIMIT_MAX: "250",
        RATE_LIMIT_AUTH_TTL: "45",
        RATE_LIMIT_AUTH_MAX: "15",
        RATE_LIMIT_RUNTIME_MAX: "900",
        RATE_LIMIT_STORAGE_TIMEOUT_MS: "750",
        RATE_LIMIT_UNAVAILABLE_RETRY_AFTER: "3",
      }),
    ).toEqual({
      keyPrefix: "podokit:tenant-a:rate-limit",
      ttlSeconds: 30,
      limit: 250,
      authTtlSeconds: 45,
      authLimit: 15,
      runtimeLimit: 900,
      storageTimeoutMs: 750,
      unavailableRetryAfterSeconds: 3,
    });
    expect(() => rateLimitConfig({ RATE_LIMIT_MAX: "0" })).toThrow(
      "RATE_LIMIT_MAX must be a positive integer",
    );
    expect(() => rateLimitConfig({ RATE_LIMIT_KEY_PREFIX: "invalid prefix!" })).toThrow(
      "RATE_LIMIT_KEY_PREFIX must be 1-128 characters",
    );
    expect(rateLimitConfig({}).keyPrefix).toBe("podokit:rate-limit");
  });

  test("reads the session signing secret the way the auth module does", () => {
    expect(
      sessionSigningSecret({ BETTER_AUTH_SECRET: "  session-secret-with-at-least-32-chars  " }),
    ).toBe("session-secret-with-at-least-32-chars");
    expect(sessionSigningSecret({ BETTER_AUTH_SECRET: "   " })).toBeUndefined();
    expect(sessionSigningSecret({})).toBeUndefined();
  });
});
