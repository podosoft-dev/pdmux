import { expect, test } from "@playwright/test";
import { e2eAdminState } from "../helpers/accounts";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";

// The API signs presigned URLs for its own S3 endpoint, so the runner can download
// one only when it was given that endpoint too. With it set, a 5xx is a failure.
test("[TC-PDHOST-031] bundled S3 storage serves a presigned download", async ({ playwright }) => {
  test.skip(!process.env.S3_ENDPOINT, "set S3_ENDPOINT to the API's bundled storage endpoint");
  const ctx = await playwright.request.newContext({
    baseURL: base,
    extraHTTPHeaders: { origin: base },
    storageState: e2eAdminState,
  });
  const key = `pdmux-storage-${Date.now()}`;
  try {
    const put = await ctx.put(`/api/storage/${key}`, { data: { content: "hello world" } });
    expect(put.ok(), await put.text()).toBeTruthy();

    const read = await ctx.get(`/api/storage/${key}`);
    expect(read.ok()).toBeTruthy();
    expect(await read.text()).toBe("hello world");

    const presigned = await ctx.get(`/api/storage/${key}/presigned`);
    expect(presigned.ok()).toBeTruthy();
    const { url } = (await presigned.json()) as { url: string };
    const download = await ctx.get(url);
    expect(download.ok()).toBeTruthy();
    expect(await download.text()).toBe("hello world");
  } finally {
    await ctx.dispose();
  }
});
