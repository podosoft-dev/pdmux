import { describe, expect, mock, test } from "bun:test";
import type { RequestGuardContext } from "../core/services";
import type { RateLimitIdentity } from "./rate-limit.identity";
import { RateLimiter } from "./rate-limit.module";
import { defaultRateLimitRoutes, RateLimitRoutes } from "./rate-limit.routes";

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

const uploads = { name: "uploads", limit: 5000, ttlSeconds: 60 };

function context(path: string, method = "GET"): { value: RequestGuardContext; headers: Record<string, string> } {
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

describe("RateLimitRoutes", () => {
  test("picks the longest prefix, then a matching method, then the latest registration", () => {
    const routes = new RateLimitRoutes(60);
    routes.register({ pathPrefix: "/files", profile: { name: "files", limit: 100 } });
    routes.register({ pathPrefix: "/files/uploads", profile: uploads });
    routes.register({ method: "put", pathPrefix: "/files/uploads/", profile: "exempt" });
    routes.register({ pathPrefix: "/reports", profile: { name: "reports", limit: 10 } });
    routes.register({ pathPrefix: "/reports", profile: { name: "reports-v2", limit: 20 } });

    expect(routes.resolve("GET", "/files/a.txt")).toEqual({ name: "files", limit: 100, ttlSeconds: 60 });
    expect(routes.resolve("POST", "/files/uploads")).toEqual(uploads);
    expect(routes.resolve("POST", "/files/uploads/1/parts/2")).toEqual(uploads);
    expect(routes.resolve("PUT", "/files/uploads/1/parts/2")).toBe("exempt");
    expect(routes.resolve("GET", "/reports/daily")).toMatchObject({ name: "reports-v2" });
    // Prefixes match whole segments only.
    expect(routes.resolve("GET", "/files-archive")).toBeUndefined();
    expect(routes.resolve("GET", "/other")).toBeUndefined();
  });

  test("rejects invalid routes and conflicting budgets under one name", () => {
    const routes = new RateLimitRoutes(60);
    expect(() => routes.register({ pathPrefix: "uploads", profile: "exempt" })).toThrow("absolute path");
    expect(() => routes.register({ pathPrefix: "/a?b", profile: "exempt" })).toThrow("absolute path");
    expect(() => routes.register({ pathPrefix: "/a//b", profile: "exempt" })).toThrow("absolute path");
    expect(() => routes.register({ method: "GET /", pathPrefix: "/a", profile: "exempt" })).toThrow("method");
    expect(() => routes.register({ pathPrefix: "/a", profile: { name: "a:b", limit: 1 } })).toThrow("name");
    expect(() => routes.register({ pathPrefix: "/a", profile: { name: "a", limit: 0 } })).toThrow("limit");
    expect(() => routes.register({ pathPrefix: "/a", profile: { name: "a", limit: 1, ttlSeconds: 1.5 } }))
      .toThrow("ttlSeconds");

    routes.register({ pathPrefix: "/a", profile: { name: "shared", limit: 10 } });
    routes.register({ pathPrefix: "/b", profile: { name: "shared", limit: 10, ttlSeconds: 60 } });
    expect(() => routes.register({ pathPrefix: "/c", profile: { name: "shared", limit: 11 } }))
      .toThrow("already registered");
  });

  test("registers the built-in budgets as routes", () => {
    const routes = defaultRateLimitRoutes(config);
    expect(routes.resolve("GET", "/anything")).toMatchObject({ name: "general", limit: 300 });
    expect(routes.resolve("POST", "/api/auth/sign-in/email")).toMatchObject({ name: "auth", limit: 20 });
    expect(routes.resolve("GET", "/api/auth/admin/list-users")).toMatchObject({ name: "general" });
    expect(routes.resolve("POST", "/api/auth/admin/ban-user")).toMatchObject({ name: "auth" });
    expect(routes.resolve("GET", "/api/auth/get-session")).toMatchObject({ name: "runtime", limit: 1000 });
    expect(routes.resolve("GET", "/site/settings")).toMatchObject({ name: "runtime" });
    expect(routes.resolve("PUT", "/site/settings")).toMatchObject({ name: "general" });
    // The built-in names keep their limits.
    expect(() => routes.register({ pathPrefix: "/x", profile: { name: "auth", limit: 1000 } }))
      .toThrow("already registered");
  });
});

describe("RateLimiter route profiles", () => {
  test("counts a registered route in its own bucket and skips exempt routes", async () => {
    const increment = mock(async (_key: string, _ttlSeconds: number) => ({ count: 1, retryAfterSeconds: 30 }));
    const limiter = new RateLimiter(
      config,
      { resolve: async () => "session:test" } as unknown as RateLimitIdentity,
      { increment },
    );
    const shortWindow = { ...uploads, ttlSeconds: 30 };
    limiter.routes.register({ pathPrefix: "/files/uploads", profile: shortWindow });
    limiter.routes.register({ method: "GET", pathPrefix: "/files/uploads/status", profile: "exempt" });
    // A more specific route can take a path out of the authentication budget.
    limiter.routes.register({ method: "GET", pathPrefix: "/api/auth/list-sessions", profile: shortWindow });

    const upload = context("/files/uploads/1/parts/1", "PUT");
    await limiter.enforce(upload.value);
    await limiter.enforce(context("/files/uploads/status").value);
    await limiter.enforce(context("/api/auth/list-sessions").value);
    await limiter.enforce(context("/api/auth/sign-out", "POST").value);

    expect(increment.mock.calls).toEqual([
      ["podokit:test:rate-limit:uploads:session:test", 30],
      ["podokit:test:rate-limit:uploads:session:test", 30],
      ["podokit:test:rate-limit:auth:session:test", 60],
    ]);
    expect(upload.headers["ratelimit-limit"]).toBe("5000");
    expect(upload.headers["ratelimit-remaining"]).toBe("4999");
  });
});
