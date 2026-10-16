import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { MemoryCacheStore, RATE_LIMIT_ROUTES } from "@podosoft/podokit-runtime";
import { Elysia } from "elysia";
import type { ApiKeyVerifier } from "../api-key/api-key-verifier";
import { configureServices } from "../app.extensions";
import { RESOLVED_SESSIONS, ResolvedSessions, ServiceRegistry, type AppContext } from "../core/services";
import { pdmuxHttpPlugin } from "../pdmux/pdmux.http";
import { PDMUX, type PdmuxServices } from "../pdmux/pdmux.services";
import { RateLimitIdentity, SessionUsers } from "../rate-limit/rate-limit.identity";
import { CacheRateLimitStorage, RateLimiter } from "../rate-limit/rate-limit.module";

const secret = "file-transfer-budget-test-secret-of-32-characters";
// The production general budget (deploy profile and .env.example).
const config = {
  keyPrefix: "pdmux:test:rate-limit",
  ttlSeconds: 60,
  limit: 300,
  authTtlSeconds: 60,
  authLimit: 20,
  runtimeLimit: 1000,
  storageTimeoutMs: 1000,
  unavailableRetryAfterSeconds: 1,
};

/** A limiter wired as the API wires it: the rate-limit module's routes, then configureServices. */
function limiter(): { limiter: RateLimiter; bearer: (token: string) => string } {
  const services = new ServiceRegistry();
  services.register(RESOLVED_SESSIONS, new ResolvedSessions());
  const users = new SessionUsers();
  services.resolve(RESOLVED_SESSIONS).listen(({ token, userId, expiresAt }) => users.remember(token, userId, expiresAt));
  const built = new RateLimiter(
    config,
    new RateLimitIdentity({ isValid: () => false } as unknown as ApiKeyVerifier, services, secret, users),
    new CacheRateLimitStorage(new MemoryCacheStore()),
  );
  services.register(RATE_LIMIT_ROUTES, built.routes);
  configureServices(services);
  const expiresAt = new Date(Date.now() + 3_600_000);
  for (const [token, userId] of [["laptop", "user-1"], ["phone", "user-1"], ["other", "user-2"]] as const) {
    services.resolve(RESOLVED_SESSIONS).report({ token, userId, expiresAt });
  }
  return {
    limiter: built,
    bearer: (token) => `Bearer ${token}.${createHmac("sha256", secret).update(token).digest("base64")}`,
  };
}

/** Every route pdmux serves under /hosts/:hostId, read from the real plugin. */
function hostRoutes(): Array<{ method: string; path: string }> {
  const services = new ServiceRegistry();
  services.register(PDMUX, {} as PdmuxServices);
  const app = new Elysia().use(pdmuxHttpPlugin({ services } as AppContext));
  return app.routes
    .filter((route) => route.path.startsWith("/hosts/:hostId"))
    .map((route) => ({ method: route.method, path: route.path }));
}

const general = { name: "general", limit: 300, ttlSeconds: 60 };

const concrete = (path: string, hostId: string): string =>
  path.replace(":hostId", hostId).replace(/:([A-Za-z]+)/g, (_match, name: string) => `${name}-1`);

describe("[TC-PDFILE-013] file transfers have a request budget of their own", () => {
  it("covers every transfer route under any host and leaves other host routes on the general budget", () => {
    const { limiter: built } = limiter();
    const routes = hostRoutes();
    const transfers = routes.filter((route) => /^\/hosts\/:hostId\/file-transfers(?:\/|$)/.test(route.path));
    const others = routes.filter((route) => !transfers.includes(route));
    // List, create, read, remove, entries, manifest, control, reconcile,
    // decision, chunk, commit, download.
    expect(transfers.length).toBeGreaterThanOrEqual(12);
    expect(others.length).toBeGreaterThan(10);

    for (const hostId of ["host-1", "6f1c2b4e-8d3a-4c5b-9e7f-0a1b2c3d4e5f"]) {
      for (const route of transfers) {
        expect({ route, profile: built.routes.resolve(route.method, concrete(route.path, hostId)) }).toEqual({
          route,
          profile: { name: "file-transfers", limit: 6_000, ttlSeconds: 60 },
        });
      }
      for (const route of others) {
        expect({ route, profile: built.routes.resolve(route.method, concrete(route.path, hostId)) }).toEqual({
          route,
          profile: general,
        });
      }
    }
    // Whole segments only, and only below a host.
    expect(built.routes.resolve("GET", "/hosts/host-1/file-transfers-archive")).toEqual(general);
    expect(built.routes.resolve("GET", "/hosts/file-transfers")).toEqual(general);
  });

  it("keeps transfers going after the general budget is spent and refuses request 6,001", async () => {
    const { limiter: built, bearer } = limiter();
    const enforce = async (token: string, method: string, path: string): Promise<Record<string, string>> => {
      const headers: Record<string, string> = {};
      await built.enforce({
        request: new Request(`http://localhost${path}`, { method, headers: { authorization: bearer(token) } }),
        clientAddress: "203.0.113.7",
        setHeader: (name, value) => { headers[name.toLowerCase()] = value; },
      });
      return headers;
    };
    const chunk = (index: number): string =>
      `/hosts/host-${index % 2}/file-transfers/job/entries/entry-${index % 7}/chunk`;

    for (let index = 0; index < 300; index += 1) await enforce("laptop", "GET", "/hosts/host-1/files");
    await expect(enforce("laptop", "GET", "/hosts/host-1/files")).rejects.toMatchObject({
      code: "RATE_LIMIT_EXCEEDED",
      statusCode: 429,
    });

    // The user's two sessions draw from one transfer budget, across hosts and routes.
    let last: Record<string, string> = {};
    for (let index = 0; index < 6_000; index += 1) {
      const route = index % 3 === 0
        ? { method: "GET", path: "/hosts/host-1/file-transfers/job" }
        : { method: "PUT", path: chunk(index) };
      last = await enforce(index % 2 === 0 ? "laptop" : "phone", route.method, route.path);
    }
    expect(last["ratelimit-limit"]).toBe("6000");
    expect(last["ratelimit-remaining"]).toBe("0");

    const refused: Record<string, string> = {};
    await expect(built.enforce({
      request: new Request(`http://localhost${chunk(6_001)}`, { method: "PUT", headers: { authorization: bearer("laptop") } }),
      clientAddress: "203.0.113.7",
      setHeader: (name, value) => { refused[name.toLowerCase()] = value; },
    })).rejects.toMatchObject({ code: "RATE_LIMIT_EXCEEDED", statusCode: 429 });
    expect(Number(refused["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(refused["retry-after"])).toBeLessThanOrEqual(60);

    // Another caller keeps a budget of its own.
    expect((await enforce("other", "PUT", chunk(1)))["ratelimit-remaining"]).toBe("5999");
  });
});
