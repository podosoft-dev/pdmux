import { expect, test } from "@playwright/test";
import { adminState } from "../helpers/accounts";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

// rate-limit installs a global throttler guard (RATE_LIMIT_MAX requests per
// RATE_LIMIT_TTL seconds) and exempts the health probes so an orchestrator can
// always tell whether the process is alive.
const limit = Number(process.env.RATE_LIMIT_MAX ?? 100);

// Two things had to be measured to make this spec safe to run in a full suite:
//
// 1. This app is secure by default, so the public demo route the shipped version
//    hammered answers 401 — and an unauthenticated request never reaches the
//    throttler, because the auth guard rejects it first (110 requests, 110×401,
//    no 429). The limit has to be exercised through a signed-in route.
// 2. The budget is shared by everything the suite does. Spending a
//    production-sized window here left the specs that ran next getting 429 on
//    their first request, which surfaced as a dozen unrelated UI failures that
//    moved around between runs. Development therefore runs a high ceiling and
//    this spec asks for its own small one; it still uses a throwaway account so
//    nothing it does touches the shared admin session.
test("rate limit: health probes stay available while ordinary routes return 429 @smoke", async ({
  playwright,
}) => {
  // A shared development stack runs a high ceiling on purpose (see .env): a
  // production-sized window is spent by the rest of the suite and then every
  // other spec fails with 429. Crossing a 2000-request limit here would take
  // minutes and prove nothing extra, so this spec asks for its own configuration.
  test.skip(
    limit > 500,
    `RATE_LIMIT_MAX=${limit} is a dev ceiling; run this with a small limit: RATE_LIMIT_MAX=20 npm run test:e2e:api`,
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
      // Health is exempt: an orchestrator probing every second must never be told
      // to back off, or a busy instance looks dead and gets restarted.
      for (const path of ["/api/health", "/api/health/ready"]) {
        for (let i = 0; i < limit + 5; i++) {
          const response = await ctx.get(path);
          expect(response.status(), `${path} request ${i + 1}`).toBe(200);
        }
      }

      const signIn = await ctx.post("/api/auth/sign-in/email", { data: { email, password } });
      test.skip(!signIn.ok(), `probe account cannot sign in (${signIn.status()})`);

      const probe = await ctx.get("/api/hosts");
      test.skip(probe.status() >= 500, "backend or throttler storage (redis) not reachable");

      let seen200 = probe.status() === 200;
      let got429 = false;
      for (let i = 0; i < limit + 10 && !got429; i++) {
        const response = await ctx.get("/api/hosts");
        if (response.status() === 200) seen200 = true;
        if (response.status() === 429) got429 = true;
      }

      // A fresh window serves the first requests (200) and rejects once the limit
      // is crossed (429).
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
