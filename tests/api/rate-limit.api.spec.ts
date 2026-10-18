import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type PlaywrightWorkerArgs,
} from "@playwright/test";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

// rate-limit installs a global guard that counts each request in one budget: the
// general one (RATE_LIMIT_MAX requests per RATE_LIMIT_TTL seconds, per client),
// the stricter authentication one for other /api/auth requests, or the runtime
// one for session reads. This module ships a global guard, so it never joins the
// shared Outer smoke app (it would throttle every other spec); this spec ships
// with the module and runs against a dedicated app.
//
// Every counted response names its budget's limit and what is left of it in the
// RateLimit-Limit and RateLimit-Remaining headers. The spec reads the limits from
// them, so it follows whatever limits the stack runs with. When the runner's
// environment sets RATE_LIMIT_MAX, RATE_LIMIT_AUTH_MAX, or RATE_LIMIT_RUNTIME_MAX,
// the spec also expects the stack to use that value. A test that sends a budget's
// worth of requests times the first ones and skips, with the reason, when the
// rest would not fit in its time, as with raised local limits. A run that should
// not send them at all sets E2E_SKIP_RATE_LIMIT=true to skip the file.
test.skip(process.env.E2E_SKIP_RATE_LIMIT === "true", "E2E_SKIP_RATE_LIMIT is true");

/** Requests a test times before it judges whether the rest fit in its time. */
const PACE_SAMPLE = 50;

let testStarted = Date.now();
test.beforeEach(() => {
  testStarted = Date.now();
});

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Why `left` more requests, sent at the pace of the `sent` ones since `since`,
 * would not end within half of the time this test has left, or undefined when
 * they would. The other half leaves room for a slower stretch.
 */
function outOfTime(sent: number, since: number, left: number): string | undefined {
  const { timeout } = test.info();
  if (timeout === 0) return undefined;
  const now = Date.now();
  const perRequest = (now - since) / sent;
  const needed = perRequest * left;
  const available = timeout - (now - testStarted);
  if (needed <= available / 2) return undefined;
  const pace = Math.round(1000 / perRequest);
  return `${left} more requests at ${pace} per second take about ${seconds(needed)}, more than half of the ${seconds(available)} this test has left`;
}

/** Requires a session, so a session's requests count under its user from the first one. */
const PROBE = "/api/account/me";
const HEALTH = ["/api/health", "/api/health/ready"];

interface Budget {
  limit: number;
  remaining: number;
}

/** The budget a response was counted in, from its RateLimit headers. */
function budget(response: APIResponse): Budget {
  const headers = response.headers();
  const limit = Number(headers["ratelimit-limit"]);
  const remaining = Number(headers["ratelimit-remaining"]);
  const counted = Number.isInteger(limit) && Number.isInteger(remaining);
  expect(counted, `RateLimit headers of ${response.url()}`).toBe(true);
  return { limit, remaining };
}

/** Expects `limit` to be the value the runner's environment sets for `name`, if it sets one. */
function expectConfigured(
  name: "RATE_LIMIT_MAX" | "RATE_LIMIT_AUTH_MAX" | "RATE_LIMIT_RUNTIME_MAX",
  limit: number,
): void {
  const configured = process.env[name];
  if (configured) expect(limit, `${name} in the runner's environment`).toBe(Number(configured));
}

/**
 * Runs a check that compares counts across several requests until it passes. A
 * counter lasts its window from its first request, so with a short
 * RATE_LIMIT_TTL a new window can start between two requests of the check and
 * reset what it compares; the next attempt starts over in that window.
 */
async function inOneWindow(check: () => Promise<void>): Promise<void> {
  await expect(check).toPass({ timeout: 30_000 });
}

/**
 * Requests the probe until the limiter answers 429, or returns why it stopped
 * first: the general window kept ending first, or the requests left to the
 * limit would not fit in the test's time. More remaining than on the request
 * before means a new window started, which starts the count over.
 */
async function untilLimited(ctx: APIRequestContext, limit: number): Promise<APIResponse | string> {
  const started = Date.now();
  let sent = 0;
  let windows = 1;
  let counted = 0;
  let previous = Number.POSITIVE_INFINITY;
  for (;;) {
    const response = await ctx.get(PROBE);
    if (response.status() === 429) return response;
    expect(response.status(), `${PROBE} request ${counted + 1} of window ${windows}`).toBe(200);
    const { remaining } = budget(response);
    sent += 1;
    if (remaining >= previous) {
      windows += 1;
      counted = 0;
      if (windows > 3) return `the general window ends before this client sends ${limit} requests`;
    }
    previous = remaining;
    counted += 1;
    // A window holds at most `limit` served requests.
    expect(counted, `requests served in one general window`).toBeLessThanOrEqual(limit);
    // Judged in each window, since a new one needs the whole limit again.
    if (counted === PACE_SAMPLE) {
      const late = outOfTime(sent, started, remaining + 1);
      if (late) return `reaching the general limit (${limit}): ${late}`;
    }
  }
}

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
/** The authentication budget's limit, as the latest sign-up or sign-in reported it. */
let authLimit = 0;

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
  authLimit = budget(response).limit;
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
  const probe = await ctx.get(PROBE);
  test.skip(probe.status() >= 500, "the limiter's storage is not reachable");
  expect(probe.status()).toBe(200);
  const { limit } = budget(probe);
  expectConfigured("RATE_LIMIT_MAX", limit);

  // Health probes are not counted: they carry no budget and leave the general one as it was.
  await inOneWindow(async () => {
    const before = budget(await ctx.get(PROBE)).remaining;
    for (const path of HEALTH) {
      for (let i = 0; i < 5; i++) {
        const response = await ctx.get(path);
        expect(response.status(), `${path} request ${i + 1}`).toBe(200);
        expect(response.headers()["ratelimit-limit"], path).toBeUndefined();
      }
    }
    expect(budget(await ctx.get(PROBE)).remaining).toBe(before - 1);
  });

  // A window serves `limit` requests and rejects the next one.
  const limited = await untilLimited(ctx, limit);
  if (typeof limited === "string") {
    test.skip(true, limited);
    return;
  }
  expect(limited.headers()["retry-after"]).toBeTruthy();
  expect(await limited.json()).toMatchObject({
    success: false,
    error: { code: "RATE_LIMIT_EXCEEDED", statusCode: 429 },
  });
  for (const path of HEALTH) {
    expect((await ctx.get(path)).status(), `${path} while the session is limited`).toBe(200);
  }
  await ctx.dispose();
});

test("rate limit: a user's sessions share one counter and forged sessions do not get one", async ({
  playwright,
}) => {
  const email = uniqueEmail();
  const first = await session(playwright, email);
  const probe = await first.get(PROBE);
  test.skip(probe.status() >= 500, "the limiter's storage is not reachable");
  const remaining = (response: APIResponse): number => budget(response).remaining;
  const { limit } = budget(probe);

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
  await second.get(PROBE);

  // Both sessions now draw from one budget: each request lowers what the next
  // one, from either session, has left.
  await inOneWindow(async () => {
    const fromFirst = remaining(await first.get(PROBE));
    expect(remaining(await second.get(PROBE))).toBe(fromFirst - 1);
    expect(remaining(await bearer.get(PROBE))).toBe(fromFirst - 2);
    expect(remaining(await first.get(PROBE))).toBe(fromFirst - 3);
  });

  // Another user has a budget of their own.
  const other = await session(playwright);
  expect(remaining(await other.get(PROBE))).toBe(limit - 1);

  // A session cookie without a valid signature is counted with anonymous traffic
  // from the same client address instead of receiving a fresh counter. The probe
  // requires a session, so compare on a public route with the general limit.
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
  const ctx = await session(playwright);
  const read = await ctx.get("/api/auth/get-session");
  test.skip(read.status() >= 500, "the limiter's storage is not reachable");
  const runtimeLimit = budget(read).limit;
  expectConfigured("RATE_LIMIT_RUNTIME_MAX", runtimeLimit);
  expectConfigured("RATE_LIMIT_AUTH_MAX", authLimit);
  // Reading past the authentication budget shows the reads are not counted in
  // it, but only while those reads fit in the runtime budget.
  const reads = authLimit + 5;
  test.skip(
    reads + 1 > runtimeLimit,
    `the authentication budget (${authLimit}) is not far enough below the runtime budget (${runtimeLimit})`,
  );
  const started = Date.now();
  for (let i = 1; i <= reads; i++) {
    const response = await ctx.get("/api/auth/get-session");
    expect(response.status(), `session request ${i}`).toBe(200);
    if (i === PACE_SAMPLE) {
      const late = outOfTime(i, started, reads - i);
      test.skip(late !== undefined, `reading past the authentication budget (${authLimit}): ${late}`);
    }
  }
  await ctx.dispose();
});

test("rate limit: each route is counted in its most specific registered budget", async ({
  playwright,
}) => {
  const ctx = await session(playwright);
  const probe = await ctx.get(PROBE);
  test.skip(probe.status() >= 500, "the limiter's storage is not reachable");
  const generalLimit = budget(probe).limit;
  expectConfigured("RATE_LIMIT_MAX", generalLimit);
  expectConfigured("RATE_LIMIT_AUTH_MAX", authLimit);

  await inOneWindow(async () => {
    // Ordinary routes fall back to the general budget registered at "/".
    const ordinary = budget(await ctx.get("/api/account/capabilities"));
    // Longer GET prefixes inside "/api/auth" win over its authentication budget:
    // administrator reads count in the general budget and session reads in the
    // runtime one.
    const adminRead = budget(await ctx.get("/api/auth/admin/list-users"));
    const sessionRead = budget(await ctx.get("/api/auth/get-session"));
    // Other "/api/auth" requests count in the strict authentication budget.
    const authWrite = budget(await ctx.post("/api/auth/update-user", { data: { name: "Rate Limit" } }));
    const sessionReadAgain = budget(await ctx.get("/api/auth/get-session"));
    const ordinaryAgain = budget(await ctx.get("/api/account/capabilities"));

    expect(ordinary.limit).toBe(generalLimit);
    expect(adminRead).toEqual({ limit: generalLimit, remaining: ordinary.remaining - 1 });
    // Neither the session reads nor the authentication write moved the general counter,
    expect(ordinaryAgain).toEqual({ limit: generalLimit, remaining: ordinary.remaining - 2 });
    // the authentication write did not move the runtime one,
    expect(sessionReadAgain).toEqual({ limit: sessionRead.limit, remaining: sessionRead.remaining - 1 });
    // and it was counted with sign-ups and sign-ins.
    expect(authWrite.limit).toBe(authLimit);
    expectConfigured("RATE_LIMIT_RUNTIME_MAX", sessionRead.limit);
  });
  await ctx.dispose();
});
