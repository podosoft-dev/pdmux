import { describe, expect, it } from "bun:test";
import { redisConnectionOptions, redisConnectionUrl } from "./redis.connection";

describe("redisConnectionOptions", () => {
  it("prefers an authenticated URL over individual settings", () => {
    expect(
      redisConnectionOptions({
        REDIS_URL: "rediss://user:p%40ss@cache.example.com:6381/4",
        REDIS_HOST: "ignored",
        REDIS_PASSWORD: "ignored",
      }),
    ).toEqual({
      host: "cache.example.com",
      port: 6381,
      db: 4,
      username: "user",
      password: "p@ss",
      tls: {},
    });
  });

  it("uses authenticated host settings when a URL is absent", () => {
    expect(
      redisConnectionOptions({
        REDIS_HOST: "cache",
        REDIS_PORT: "6380",
        REDIS_DB: "2",
        REDIS_USERNAME: "app",
        REDIS_PASSWORD: "secret",
        REDIS_TLS: "true",
      }),
    ).toEqual({
      host: "cache",
      port: 6380,
      db: 2,
      username: "app",
      password: "secret",
      tls: {},
    });
  });

  it("does not include a malformed URL value in its error", () => {
    const secretUrl = "not-a-url-with-a-secret";
    expect(() => redisConnectionOptions({ REDIS_URL: secretUrl })).toThrow(
      "REDIS_URL must be a valid redis:// or rediss:// URL",
    );
    try {
      redisConnectionOptions({ REDIS_URL: secretUrl });
    } catch (error) {
      expect(String(error)).not.toContain(secretUrl);
    }
  });
});

describe("redisConnectionUrl", () => {
  it("preserves an explicitly configured URL after validation", () => {
    expect(redisConnectionUrl({ REDIS_URL: "rediss://user:p%40ss@example.com:6381/4" }))
      .toBe("rediss://user:p%40ss@example.com:6381/4");
  });

  it("builds a Bun Redis URL from host-style environment variables", () => {
    expect(redisConnectionUrl({
      REDIS_HOST: "cache.example.com",
      REDIS_PORT: "6381",
      REDIS_DB: "4",
      REDIS_USERNAME: "podokit",
      REDIS_PASSWORD: "p@ss",
      REDIS_TLS: "true",
    })).toBe("rediss://podokit:p%40ss@cache.example.com:6381/4");
  });
});
