import { expect, test } from "@playwright/test";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

// Self-contained: sign up + sign in a disposable account so the test works when
// `auth`'s global guard is installed (the common case). Harmless if the API is open.
async function session(playwright: import("@playwright/test").PlaywrightWorkerArgs["playwright"]) {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const email = `redis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await ctx.post("/api/auth/sign-up/email", { data: { email, password: "Podokit3e-Str0ng!pw", name: "R" } }).catch(() => undefined);
  return ctx;
}

test("redis cache: set, get, and miss @smoke", async ({ playwright }) => {
  const ctx = await session(playwright);
  const key = `k-${Date.now()}`;
  const put = await ctx.put(`/api/cache/${key}`, { data: { value: "hello", ttl: 60 } });
  test.skip(put.status() >= 500, "redis not reachable");
  expect(put.ok()).toBeTruthy();
  expect(await put.json()).toMatchObject({ key });

  const got = await (await ctx.get(`/api/cache/${key}`)).json();
  expect(got).toMatchObject({ key, value: "hello" });

  const miss = await (await ctx.get(`/api/cache/missing-${Date.now()}`)).json();
  expect(miss.value).toBeNull();

  await ctx.dispose();
});
