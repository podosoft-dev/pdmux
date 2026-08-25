import { describe, expect, test } from "bun:test";
import {
  clientAddressFromProxy,
  rateLimitConfig,
} from "./rate-limit.config";

describe("rate limit configuration", () => {
  test("validates route limits and proxy settings", () => {
    expect(
      rateLimitConfig({
        RATE_LIMIT_KEY_PREFIX: "podokit:tenant-a:rate-limit",
        RATE_LIMIT_TTL: "30",
        RATE_LIMIT_MAX: "250",
        RATE_LIMIT_AUTH_TTL: "45",
        RATE_LIMIT_AUTH_MAX: "15",
        RATE_LIMIT_RUNTIME_MAX: "900",
        RATE_LIMIT_TRUSTED_PROXY_HOPS: "2",
        RATE_LIMIT_PROXY_HEADER: "X-Real-IP",
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
      trustedProxyHops: 2,
      proxyHeader: "x-real-ip",
      storageTimeoutMs: 750,
      unavailableRetryAfterSeconds: 3,
    });
    expect(() => rateLimitConfig({ RATE_LIMIT_MAX: "0" })).toThrow(
      "RATE_LIMIT_MAX must be a positive integer",
    );
    expect(() =>
      rateLimitConfig({ RATE_LIMIT_TRUSTED_PROXY_HOPS: "-1" }),
    ).toThrow("must be a non-negative integer");
    expect(() =>
      rateLimitConfig({ RATE_LIMIT_PROXY_HEADER: "invalid header" }),
    ).toThrow("must be a valid HTTP header name");
    expect(() => rateLimitConfig({ RATE_LIMIT_KEY_PREFIX: "invalid prefix!" })).toThrow(
      "RATE_LIMIT_KEY_PREFIX must be 1-128 characters",
    );
    expect(rateLimitConfig({}).keyPrefix).toBe("podokit:rate-limit");
  });

  test("selects only the address outside the configured trusted proxy depth", () => {
    const headers = {
      "x-forwarded-for": "203.0.113.7, 198.51.100.8",
    };
    expect(
      clientAddressFromProxy(headers, "10.0.0.9", {
        proxyHeader: "x-forwarded-for",
        trustedProxyHops: 2,
      }),
    ).toBe("203.0.113.7");
    expect(
      clientAddressFromProxy(headers, "10.0.0.9", {
        proxyHeader: "x-forwarded-for",
        trustedProxyHops: 1,
      }),
    ).toBe("198.51.100.8");
    expect(
      clientAddressFromProxy(headers, "10.0.0.9", {
        proxyHeader: "x-forwarded-for",
        trustedProxyHops: 0,
      }),
    ).toBe("10.0.0.9");
  });

  test("ignores malformed or incomplete forwarded chains", () => {
    expect(
      clientAddressFromProxy(
        { "x-forwarded-for": "attacker-controlled" },
        "::ffff:10.0.0.9",
        {
          proxyHeader: "x-forwarded-for",
          trustedProxyHops: 1,
        },
      ),
    ).toBe("10.0.0.9");
    expect(
      clientAddressFromProxy({}, "10.0.0.9", {
        proxyHeader: "x-forwarded-for",
        trustedProxyHops: 1,
      }),
    ).toBe("10.0.0.9");
  });
});
