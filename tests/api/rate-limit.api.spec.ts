import { expect, test, type APIResponse } from "@playwright/test";
import { adminState } from "../helpers/accounts";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

// The global limit is shared by every request that reaches this stack. Exercising a
// production-sized window inside the full suite would leave all following tests rate-limited.
const limit = Number(process.env.RATE_LIMIT_MAX ?? 300);
const authLimit = Number(process.env.RATE_LIMIT_AUTH_MAX ?? 20);

async function session(
  playwright: import("@playwright/test").PlaywrightWorkerArgs["playwright"],
) {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const email = `rate-limit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const signup = await ctx.post("/api/auth/sign-up/email", {
    data: {
      email,
      password: "Podokit3e-Str0ng!pw",
      name: "Rate Limit",
    },
  });
  expect(signup.ok()).toBeTruthy();
  return ctx;
}

test("rate limit: health probes stay available while ordinary routes return 429 @smoke", async ({
  playwright,
}) => {
  // The full isolated suite deliberately uses a high ceiling. Exercise this contract against
  // a dedicated low-limit stack instead of consuming the shared suite's whole request budget.
  test.skip(
    limit > 500,
    `RATE_LIMIT_MAX=${limit} is an e2e ceiling; run this with a small limit: RATE_LIMIT_MAX=20 bun run test:e2e:api`,
  );

  const admin = await playwright.request.newContext({
    baseURL: base,
    storageState: adminState,
    extraHTTPHeaders: origin,
  });
  const email = `rate-limit-${Date.now()}@example.com`;
  const password = "Podokit3e-Str0ng!pw";
  let userId = "";

  try {
    const created = await admin.post("/api/auth/admin/create-user", {
      data: { email, password, name: "Rate Limit Probe", role: "user" },
    });
    test.skip(!created.ok(), `cannot create the probe account (${created.status()})`);
    userId = ((await created.json()).user?.id ?? "") as string;
    expect(userId, "the probe account must exist for its budget to be isolated").toBeTruthy();

    const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
    try {
      for (const path of ["/api/health", "/api/health/ready"]) {
        for (let index = 0; index < limit + 5; index += 1) {
          const response = await ctx.get(path);
          expect(response.status(), `${path} request ${index + 1}`).toBe(200);
        }
      }

      const signIn = await ctx.post("/api/auth/sign-in/email", { data: { email, password } });
      test.skip(!signIn.ok(), `probe account cannot sign in (${signIn.status()})`);

      const probe = await ctx.get("/api/hosts");
      test.skip(probe.status() >= 500, "backend or throttler storage is not reachable");

      let seen200 = probe.status() === 200;
      let got429 = false;
      for (let index = 0; index < limit + 10 && !got429; index += 1) {
        const response = await ctx.get("/api/hosts");
        if (response.status() === 200) seen200 = true;
        if (response.status() === 429) got429 = true;
      }

      expect(seen200).toBe(true);
      expect(got429).toBe(true);
    } finally {
      await ctx.dispose();
    }
  } finally {
    if (userId) {
      await admin.post("/api/auth/admin/remove-user", { data: { userId } });
    }
    await admin.dispose();
  }
});

test("rate limit: a user's sessions share one counter and forged sessions do not get one", async ({
  playwright,
}) => {
  const email = `rate-limit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = "Podokit3e-Str0ng!pw";
  const first = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  expect((await first.post("/api/auth/sign-up/email", { data: { email, password, name: "Rate Limit" } })).ok()).toBeTruthy();
  const probe = await first.get("/api/cache/rate-limit-probe");
  test.skip(probe.status() >= 500, "throttler storage (redis) not reachable");
  const remaining = (response: APIResponse): number => Number(response.headers()["ratelimit-remaining"]);
  const ceiling = Number(probe.headers()["ratelimit-limit"]);

  // A second sign-in of the same user, and the signed bearer form of the first
  // session. The probe requires a session, so each request below resolves it; a
  // session counts under its user from the request after the API first resolves
  // it (or from that request when authentication runs before the limiter).
  const second = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  expect((await second.post("/api/auth/sign-in/email", { data: { email, password } })).ok()).toBeTruthy();
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
