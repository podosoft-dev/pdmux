import { expect, test } from "@playwright/test";
import { e2eAdminState } from "../helpers/accounts";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";

interface HostRow {
  id: string;
  online: boolean;
  enabled: boolean;
  capabilities: string[];
}

test("[TC-PDTERM-150] file operations cross the live agent transport", async ({ playwright }) => {
  const ctx = await playwright.request.newContext({
    baseURL: base,
    extraHTTPHeaders: { origin: base },
    storageState: e2eAdminState,
  });
  const hostsResponse = await ctx.get("/api/hosts");
  expect(hostsResponse.ok(), await hostsResponse.text()).toBeTruthy();
  const hosts = (await hostsResponse.json()) as HostRow[];
  const host = hosts.find((candidate) =>
    candidate.online && candidate.enabled && candidate.capabilities.includes("files")
  );
  test.skip(!host, "no online file-capable host — start an agent to exercise file transfer");
  if (!host) {
    await ctx.dispose();
    return;
  }

  const path = `pdmux-e2e-${Date.now()}.txt`;
  const contents = Buffer.from("hello\npdmux\n", "utf8");
  let uploaded = false;

  try {
    const upload = await ctx.post(
      `/api/hosts/${host.id}/files/upload?path=${encodeURIComponent(path)}`,
      { data: contents, headers: { "content-type": "application/octet-stream" } },
    );
    expect(upload.ok(), await upload.text()).toBeTruthy();
    expect((await upload.json()) as { written: number; size: number; error: string | null }).toMatchObject({
      written: contents.length,
      size: contents.length,
      error: null,
    });
    uploaded = true;

    const listed = await ctx.get(`/api/hosts/${host.id}/files?path=`);
    expect(listed.ok(), await listed.text()).toBeTruthy();
    expect(((await listed.json()) as { entries: { name: string }[] }).entries).toContainEqual(
      expect.objectContaining({ name: path }),
    );

    const viewed = await ctx.get(
      `/api/hosts/${host.id}/files/content?path=${encodeURIComponent(path)}`,
    );
    expect(viewed.ok(), await viewed.text()).toBeTruthy();
    expect((await viewed.json()) as { lines: string[]; binary: boolean; error: string | null }).toMatchObject({
      lines: ["hello", "pdmux"],
      binary: false,
      error: null,
    });

    const downloaded = await ctx.get(
      `/api/hosts/${host.id}/files/download?path=${encodeURIComponent(path)}`,
    );
    expect(downloaded.status(), await downloaded.text()).toBe(200);
    expect(await downloaded.body()).toEqual(contents);
    expect(downloaded.headers()["content-disposition"]).toContain("attachment");

    const resumed = await ctx.get(
      `/api/hosts/${host.id}/files/download?path=${encodeURIComponent(path)}`,
      { headers: { range: "bytes=6-" } },
    );
    expect(resumed.status(), await resumed.text()).toBe(206);
    expect(await resumed.body()).toEqual(Buffer.from("pdmux\n", "utf8"));
    expect(resumed.headers()["content-range"]).toBe(`bytes 6-${contents.length - 1}/${contents.length}`);
  } finally {
    if (uploaded) {
      const removed = await ctx.delete(
        `/api/hosts/${host.id}/files?path=${encodeURIComponent(path)}`,
      );
      expect(removed.ok(), await removed.text()).toBeTruthy();
      expect((await removed.json()) as { removed: number; error: string | null }).toMatchObject({
        removed: 1,
        error: null,
      });
    }
    await ctx.dispose();
  }
});
