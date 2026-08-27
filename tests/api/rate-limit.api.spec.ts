import { expect, test } from "@playwright/test";
import { adminState } from "../helpers/accounts";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

// The global limit is shared by every request that reaches this stack. Exercising a
// production-sized window inside the full suite would leave all following tests rate-limited.
const limit = Number(process.env.RATE_LIMIT_MAX ?? 100);

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
