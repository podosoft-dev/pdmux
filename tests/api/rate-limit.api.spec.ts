import { expect, test, type APIResponse } from "@playwright/test";

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
const limit = Number(process.env.RATE_LIMIT_MAX ?? 300);

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
