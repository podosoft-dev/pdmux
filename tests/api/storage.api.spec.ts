import { expect, test } from "@playwright/test";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

async function session(playwright: import("@playwright/test").PlaywrightWorkerArgs["playwright"]) {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const email = `storage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await ctx.post("/api/auth/sign-up/email", { data: { email, password: "Podokit3e-Str0ng!pw", name: "S" } }).catch(() => undefined);
  return ctx;
}

test("object storage: put, get, and presign @smoke", async ({ playwright }) => {
  const ctx = await session(playwright);
  const key = `obj-${Date.now()}`;
  const put = await ctx.put(`/api/storage/${key}`, { data: { content: "hello world" } });
  test.skip(put.status() >= 500, "object storage (MinIO/S3) not reachable");
  expect(put.ok()).toBeTruthy();
  expect(await put.json()).toMatchObject({ key });

  const got = await (await ctx.get(`/api/storage/${key}`)).json();
  expect(got).toMatchObject({ key, content: "hello world" });

  const pre = await (await ctx.get(`/api/storage/${key}/presigned`)).json();
  expect(String(pre.url)).toContain(key);

  await ctx.dispose();
});
