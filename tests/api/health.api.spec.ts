import { expect, test } from "@playwright/test";

// Health endpoints are public and present in every generated app.
test("GET /health is public and ok @smoke", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBeTruthy();
  expect((await res.json()).status).toBe("ok");
});

test("GET /health/ready reports the database", async ({ request }) => {
  const res = await request.get("/api/health/ready");
  expect(res.status()).toBe(200);
  expect((await res.json()).status).toBe("ready");
});

test("GET /healthz answers from the web server without caching or indexing @smoke", async ({ request }) => {
  const res = await request.get("/healthz");
  expect(res.status()).toBe(200);
  expect(await res.text()).toBe("ok\n");
  expect(res.headers()["cache-control"]).toBe("no-store");
  expect(res.headers()["x-robots-tag"]).toBe("noindex, nofollow");
});
