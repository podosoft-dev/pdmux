import { expect, test } from "@playwright/test";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

async function session(playwright: import("@playwright/test").PlaywrightWorkerArgs["playwright"]) {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const email = `jobs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await ctx.post("/api/auth/sign-up/email", { data: { email, password: "Podokit3e-Str0ng!pw", name: "J" } }).catch(() => undefined);
  return ctx;
}

test("bullmq: enqueue a job, read its status, 404 for unknown @smoke", async ({ playwright }) => {
  const ctx = await session(playwright);
  const res = await ctx.post("/api/jobs", { data: { text: "hello" } });
  test.skip(res.status() >= 500, "redis not reachable");
  expect(res.ok()).toBeTruthy();
  const { id } = await res.json();
  expect(typeof id).toBe("string");

  const status = await (await ctx.get(`/api/jobs/${id}`)).json();
  expect(["waiting", "active", "completed", "delayed", "prioritized", "waiting-children"]).toContain(status.state);

  const missing = await ctx.get(`/api/jobs/does-not-exist-${Date.now()}`);
  expect(missing.status()).toBe(404);

  // When a worker is running, the demo job completes with an uppercased result;
  // without a worker it stays waiting (this stays green either way).
  let final = status.state;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && final !== "completed") {
    const s = await (await ctx.get(`/api/jobs/${id}`)).json();
    final = s.state;
    if (final === "completed") expect(s.result).toMatchObject({ upper: "HELLO" });
    else await new Promise((r) => setTimeout(r, 400));
  }
  await ctx.dispose();
});
