import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type PlaywrightWorkerArgs,
} from "@playwright/test";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

// rate-limit installs a global throttler guard (default RATE_LIMIT_MAX requests
// per RATE_LIMIT_TTL seconds, per client). This module ships a global guard, so
// it never joins the shared Outer smoke app (it would throttle every other
// spec); this spec ships with the module and runs against a dedicated app.
//
// Honor RATE_LIMIT_MAX when the test runner has it (a dedicated app sets a small
// value so the window is crossed in a handful of requests); otherwise fall back
// to the module default and allow a little headroom.
// A local stack that raises the limits to run the whole suite quickly sets
// E2E_SKIP_RATE_LIMIT=true and runs this file separately against the defaults.
test.skip(process.env.E2E_SKIP_RATE_LIMIT === "true", "assumes the configured limits; run it on its own");

const limit = Number(process.env.RATE_LIMIT_MAX ?? 300);
const authLimit = Number(process.env.RATE_LIMIT_AUTH_MAX ?? 20);
const runtimeLimit = Number(process.env.RATE_LIMIT_RUNTIME_MAX ?? 1000);

type Playwright = PlaywrightWorkerArgs["playwright"];
const password = "Podokit3e-Str0ng!pw";

function uniqueEmail(): string {
  return `rate-limit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

// Sign-ups and sign-ins are authentication writes. From an anonymous client the
// limiter counts them against the per-address budget that the setup project's
// and every other spec's sign-ins share. Only this worker's first one is
// anonymous: the later ones carry its session cookie, so the limiter counts them
// against that session instead.
let carrier: string | undefined;

/** Run one authentication write and return a context holding the session it set. */
async function authenticated(
  playwright: Playwright,
  path: "/api/auth/sign-up/email" | "/api/auth/sign-in/email",
  data: Record<string, string>,
): Promise<APIRequestContext> {
  const writer = await playwright.request.newContext({
    baseURL: base,
    extraHTTPHeaders: { ...origin, ...(carrier ? { cookie: carrier } : {}) },
  });
  const response = await writer.post(path, { data });
  expect(response.ok(), `${path}: ${response.status()}`).toBeTruthy();
  const storageState = await writer.storageState();
  await writer.dispose();
  const token = storageState.cookies.find((cookie) => cookie.name.endsWith("session_token"));
  carrier ??= token ? `${token.name}=${token.value}` : undefined;
  return playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin, storageState });
}

/** A new account, signed in. */
async function session(playwright: Playwright, email = uniqueEmail()): Promise<APIRequestContext> {
  return authenticated(playwright, "/api/auth/sign-up/email", { email, password, name: "Rate Limit" });
}

test("rate limit: health probes stay available while ordinary routes return 429 @smoke", async ({
  playwright,
}) => {
  const ctx = await session(playwright);
  for (const path of ["/api/health", "/api/health/ready"]) {
    for (let i = 0; i < limit + 5; i++) {
      const response = await ctx.get(path);
      expect(response.status(), `${path} request ${i + 1}`).toBe(200);
    }
  }

  // The redis module is added automatically and exposes a public demo cache
  // route, so it provides a stable ordinary endpoint for the global limit.
  const probe = await ctx.get("/api/cache/rate-limit-probe");
  test.skip(probe.status() >= 500, "throttler storage (redis) not reachable");

  let seen200 = probe.status() === 200;
  let limitedResponse: APIResponse | undefined;
  for (let i = 0; i < limit + 5 && !limitedResponse; i++) {
    const response = await ctx.get("/api/cache/rate-limit-probe");
    if (response.status() === 200) seen200 = true;
    if (response.status() === 429) limitedResponse = response;
  }
  // A fresh window serves the first requests (200) and rejects once the limit is
  // crossed (429).
  expect(seen200).toBe(true);
  expect(limitedResponse?.status()).toBe(429);
  expect(limitedResponse?.headers()["retry-after"]).toBeTruthy();
  expect(await limitedResponse?.json()).toMatchObject({
    success: false,
    error: { code: "RATE_LIMIT_EXCEEDED", statusCode: 429 },
  });
  await ctx.dispose();
});

test("rate limit: a user's sessions share one counter and forged sessions do not get one", async ({
  playwright,
}) => {
  const email = uniqueEmail();
  const first = await session(playwright, email);
  const probe = await first.get("/api/cache/rate-limit-probe");
  test.skip(probe.status() >= 500, "throttler storage (redis) not reachable");
  const remaining = (response: APIResponse): number => Number(response.headers()["ratelimit-remaining"]);
  const ceiling = Number(probe.headers()["ratelimit-limit"]);

  // A second sign-in of the same user, and the signed bearer form of the first
  // session. The probe requires a session, so each request below resolves it; a
  // session counts under its user from the request after the API first resolves
  // it (or from that request when authentication runs before the limiter).
  const second = await authenticated(playwright, "/api/auth/sign-in/email", { email, password });
  const cookie = (await first.storageState()).cookies.find((c) => c.name.endsWith("session_token"));
  expect(cookie, "sign-up set a session cookie").toBeTruthy();
  const bearer = await playwright.request.newContext({
    baseURL: base,
    extraHTTPHeaders: { ...origin, authorization: `Bearer ${cookie?.value ?? ""}` },
  });
  await second.get("/api/cache/rate-limit-probe");

  // Both sessions now draw from one budget: each request lowers what the next
  // one, from either session, has left.
  const fromFirst = remaining(await first.get("/api/cache/rate-limit-probe"));
  expect(remaining(await second.get("/api/cache/rate-limit-probe"))).toBe(fromFirst - 1);
  expect(remaining(await bearer.get("/api/cache/rate-limit-probe"))).toBe(fromFirst - 2);
  expect(remaining(await first.get("/api/cache/rate-limit-probe"))).toBe(fromFirst - 3);

  // Another user has a budget of their own.
  const other = await session(playwright);
  expect(remaining(await other.get("/api/cache/rate-limit-probe"))).toBe(ceiling - 1);

  // A session cookie without a valid signature is counted with anonymous traffic
  // from the same client address instead of receiving a fresh counter. The cache
  // probe requires a session, so compare on a public route with the general limit.
  const token = decodeURIComponent(cookie?.value ?? "").split(".")[0] ?? "";
  const forged = await playwright.request.newContext({
    baseURL: base,
    extraHTTPHeaders: { ...origin, cookie: `${cookie?.name ?? ""}=${token}.${"A".repeat(43)}%3D` },
  });
  const anonymous = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await expect(async () => {
    const before = await anonymous.get("/api/account/capabilities");
    const after = await forged.get("/api/account/capabilities");
    expect(before.status()).toBe(200);
    expect(remaining(after)).toBeLessThan(remaining(before));
  }).toPass({ timeout: 10_000 });

  for (const context of [first, second, bearer, other, forged, anonymous]) await context.dispose();
});

test("rate limit: session reads do not consume the strict authentication budget", async ({
  playwright,
}) => {
  test.skip(authLimit > 1000, "the authentication budget is too large to exhaust here");
  const ctx = await session(playwright);
  for (let i = 0; i < authLimit + 5; i++) {
    const response = await ctx.get("/api/auth/get-session");
    expect(response.status(), `session request ${i + 1}`).toBe(200);
  }
  await ctx.dispose();
});

test("rate limit: each route is counted in its most specific registered budget", async ({
  playwright,
}) => {
  const ctx = await session(playwright);
  const probe = await ctx.get("/api/account/capabilities");
  test.skip(probe.status() >= 500, "throttler storage (redis) not reachable");
  const ceiling = (response: APIResponse): number => Number(response.headers()["ratelimit-limit"]);

  // Ordinary routes fall back to the general budget registered at "/".
  expect(ceiling(probe)).toBe(limit);
  // Longer GET prefixes inside "/api/auth" win over its authentication budget:
  // session reads use the runtime budget and administrator reads the general one.
  expect(ceiling(await ctx.get("/api/auth/get-session"))).toBe(runtimeLimit);
  expect(ceiling(await ctx.get("/api/auth/admin/list-users"))).toBe(limit);
  // Other "/api/auth" requests carry the strict authentication budget.
  expect(ceiling(await ctx.post("/api/auth/sign-out", { data: {} }))).toBe(authLimit);
  await ctx.dispose();
});
