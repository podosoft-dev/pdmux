import { expect, test, type APIRequestContext, type PlaywrightWorkerArgs } from "@playwright/test";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

async function session(playwright: PlaywrightWorkerArgs["playwright"]): Promise<APIRequestContext> {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const email = `storage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await ctx.post("/api/auth/sign-up/email", { data: { email, password: "Podokit3e-Str0ng!pw", name: "S" } }).catch(() => undefined);
  return ctx;
}

test("[TC-PDHOST-031] object storage: put, get, and download a presigned URL @smoke", async ({ playwright }) => {
  test.skip(!process.env.S3_ENDPOINT, "Set S3_ENDPOINT to require the S3-compatible storage smoke test");
  const ctx = await session(playwright);
  const key = `obj-${crypto.randomUUID()}`;
  try {
    const put = await ctx.put(`/api/storage/${key}`, { data: { content: "hello world" } });
    expect(put.ok(), `Object upload failed with HTTP ${put.status()}`).toBeTruthy();
    expect(await put.json()).toMatchObject({ key });

    const got = await ctx.get(`/api/storage/${key}`);
    expect(got.ok()).toBeTruthy();
    expect(await got.json()).toMatchObject({ key, content: "hello world" });

    const presigned = await ctx.get(`/api/storage/${key}/presigned`);
    expect(presigned.ok()).toBeTruthy();
    const pre: { url?: unknown } = await presigned.json();
    expect(pre.url).toEqual(expect.any(String));
    if (typeof pre.url !== "string") throw new Error("Expected a presigned object URL");
    expect(pre.url).toContain(key);
    const downloadContext = await playwright.request.newContext();
    try {
      const download = await downloadContext.get(pre.url);
      expect(download.ok()).toBeTruthy();
      expect(await download.text()).toBe("hello world");
    } finally {
      await downloadContext.dispose();
    }
  } finally {
    await ctx.dispose();
  }
});
