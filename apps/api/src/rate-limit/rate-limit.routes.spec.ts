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
      clientAddress: "127.0.0.1",
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

  test("matches a :name parameter against exactly one non-empty segment", () => {
    const routes = new RateLimitRoutes(60);
    const transfers = { name: "file-transfers", limit: 600 };
    routes.register({ pathPrefix: "/hosts/:hostId/file-transfers", profile: transfers });

    expect(routes.resolve("PUT", "/hosts/h1/file-transfers/t1/chunks/3")).toMatchObject(transfers);
    expect(routes.resolve("GET", "/hosts/h1/file-transfers")).toMatchObject(transfers);
    expect(routes.resolve("GET", "/hosts/h1/file-transfers/")).toMatchObject(transfers);
    expect(routes.resolve("GET", "/hosts/h1/file-transfers-old")).toBeUndefined();
    expect(routes.resolve("GET", "/hosts/file-transfers")).toBeUndefined();
    expect(routes.resolve("GET", "/hosts//file-transfers")).toBeUndefined();
    expect(routes.resolve("GET", "/hosts/h1/h2/file-transfers")).toBeUndefined();
  });

  test("prefers more segments, then a literal segment over a parameter from the left", () => {
    const routes = new RateLimitRoutes(60);
    routes.register({ pathPrefix: "/hosts/:hostId/:section/:id", profile: { name: "deep", limit: 1 } });
    routes.register({ pathPrefix: "/hosts/:hostId/files", profile: { name: "files", limit: 2 } });
    routes.register({ pathPrefix: "/hosts/local/:section", profile: { name: "local", limit: 3 } });
    routes.register({ pathPrefix: "/hosts", profile: { name: "hosts", limit: 4 } });

    expect(routes.resolve("GET", "/hosts/local/files/1")).toMatchObject({ name: "deep" });
    expect(routes.resolve("GET", "/hosts/local/files")).toMatchObject({ name: "local" });
    expect(routes.resolve("GET", "/hosts/h2/files")).toMatchObject({ name: "files" });
    expect(routes.resolve("GET", "/hosts/h2/logs")).toMatchObject({ name: "hosts" });

    // Equal specificity falls back to the method, then the latest registration.
    routes.register({ method: "GET", pathPrefix: "/hosts/:a/logs", profile: "exempt" });
    routes.register({ pathPrefix: "/hosts/:b/logs", profile: { name: "logs", limit: 5 } });
    expect(routes.resolve("GET", "/hosts/h2/logs")).toBe("exempt");
    expect(routes.resolve("POST", "/hosts/h2/logs")).toMatchObject({ name: "logs" });
  });

  test("rejects invalid routes and conflicting budgets under one name", () => {
    const routes = new RateLimitRoutes(60);
    expect(() => routes.register({ pathPrefix: "uploads", profile: "exempt" })).toThrow("absolute path");
    expect(() => routes.register({ pathPrefix: "/a?b", profile: "exempt" })).toThrow("absolute path");
    expect(() => routes.register({ pathPrefix: "/a//b", profile: "exempt" })).toThrow("absolute path");
    expect(() => routes.register({ pathPrefix: "/a/../b", profile: "exempt" })).toThrow('".." segments');
    expect(() => routes.register({ pathPrefix: "/a/*", profile: "exempt" })).toThrow("not wildcards");
    for (const parameter of [":", ":1st", ":host-id", ":a:b"]) {
      expect(() => routes.register({ pathPrefix: `/hosts/${parameter}/x`, profile: "exempt" })).toThrow("parameter");
    }
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
  test("advertises the built-in budget of each default route", async () => {
    const limiter = new RateLimiter(
      config,
      { resolve: async () => "session:test" } as unknown as RateLimitIdentity,
      { increment: async () => ({ count: 1, retryAfterSeconds: 60 }) },
    );
    const ceiling = async (path: string, method = "GET"): Promise<string | undefined> => {
      const request = context(path, method);
      await limiter.enforce(request.value);
      return request.headers["ratelimit-limit"];
    };

    expect(await ceiling("/api/auth/get-session")).toBe("1000");
    expect(await ceiling("/site/settings")).toBe("1000");
    expect(await ceiling("/api/auth/admin/list-users")).toBe("300");
    expect(await ceiling("/api/auth/admin/ban-user", "POST")).toBe("20");
    expect(await ceiling("/api/auth/sign-out", "POST")).toBe("20");
    expect(await ceiling("/api/auth/sign-in/email", "POST")).toBe("20");
    expect(await ceiling("/site/settings", "PUT")).toBe("300");
    expect(await ceiling("/account/capabilities")).toBe("300");
  });

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
