import { expect, test } from "@playwright/test";
import { ADMIN } from "../helpers/accounts";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };
const IMMUTABLE = "public, max-age=31536000, immutable";
const ICON = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

// Fresh admin context so these never rotate the seeded admin session.
async function adminCtx(playwright: import("@playwright/test").PlaywrightWorkerArgs["playwright"]) {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await ctx.post("/api/auth/sign-in/email", { data: { email: ADMIN.email, password: ADMIN.password } });
  return ctx;
}

test("theme settings: valid preset/radius/accent round-trip", async ({ playwright }) => {
  const admin = await adminCtx(playwright);
  const put = await admin.put("/api/site/settings", {
    data: { themePreset: "slate", themeRadius: "0.75", brandColor: "#2563eb" },
  });
  expect(put.ok()).toBeTruthy();

  const anon = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const settings = await (await anon.get("/api/site/settings")).json();
  expect(settings.themePreset).toBe("slate");
  expect(settings.themeRadius).toBe("0.75");
  expect(settings.brandColor).toBe("#2563eb");

  // restore
  await admin.put("/api/site/settings", { data: { themePreset: "", themeRadius: "", brandColor: "" } });
  await anon.dispose();
});

test("theme settings: valid per-token overrides accepted", async ({ playwright }) => {
  const admin = await adminCtx(playwright);
  const overrides = JSON.stringify({ light: { primary: "#123456" }, dark: { background: "#0a0a0a" } });
  const put = await admin.put("/api/site/settings", { data: { themeOverrides: overrides } });
  expect(put.ok()).toBeTruthy();
  await admin.put("/api/site/settings", { data: { themeOverrides: "" } }); // restore
});

test("theme settings: invalid values are rejected (no CSS injection)", async ({ playwright }) => {
  const admin = await adminCtx(playwright);
  const bad = [
    { brandColor: "red; } body{display:none" },
    { brandColor: "notacolor" },
    { themeRadius: "9" },
    { themeRadius: "-1" },
    { themePreset: "bad preset!" },
    { themeOverrides: "{not json" },
    { themeOverrides: JSON.stringify({ light: { primary: "nothex" } }) },
    { themeOverrides: JSON.stringify({ light: { bogusToken: "#ffffff" } }) },
    { unknownKey: "x" },
  ];
  for (const data of bad) {
    expect((await admin.put("/api/site/settings", { data })).status(), JSON.stringify(data)).toBe(400);
  }
});

test("site settings: one response shape and immediate reads after each write", async ({ playwright }) => {
  const admin = await adminCtx(playwright);
  const anon = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const before = await (await anon.get("/api/site/settings")).json() as Record<string, unknown>;
  expect(Object.keys(before)).toEqual([
    "name", "description", "supportEmail", "footerText", "brandColor", "themePreset", "themeRadius",
    "themeOverrides", "termsUrl", "privacyUrl", "locale", "timezone", "maintenanceMode", "allowSignup",
    "hasFavicon", "faviconVersion",
  ]);
  expect(typeof before.hasFavicon).toBe("boolean");
  expect(before.faviconVersion === null || typeof before.faviconVersion === "string").toBe(true);

  try {
    // The second write lands while the first read is still cached; it must not be hidden.
    for (const footerText of ["first footer", "second footer"]) {
      expect((await admin.put("/api/site/settings", { data: { footerText } })).ok()).toBeTruthy();
      expect((await (await anon.get("/api/site/settings")).json()).footerText).toBe(footerText);
    }
  } finally {
    const footerText = typeof before.footerText === "string" ? before.footerText : "";
    await admin.put("/api/site/settings", { data: { footerText } });
    await anon.dispose();
    await admin.dispose();
  }
});

test("site favicon: the versioned URL is cached for good and other URLs revalidate", async ({ playwright }) => {
  const admin = await adminCtx(playwright);
  const anon = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  try {
    const upload = await admin.post("/api/site/favicon", {
      multipart: { file: { name: "favicon.png", mimeType: "image/png", buffer: ICON } },
    });
    expect(upload.status()).toBe(201);
    const { version } = await upload.json() as { version: string };
    expect((await (await anon.get("/api/site/settings")).json()).faviconVersion).toBe(version);

    const current = await anon.get(`/api/site/favicon?v=${encodeURIComponent(version)}`);
    expect(current.status()).toBe(200);
    expect(current.headers()["cache-control"]).toBe(IMMUTABLE);
    expect(current.headers()["content-type"]).toContain("image/png");
    expect(current.headers()["content-length"]).toBe(String(ICON.byteLength));
    expect((await current.body()).equals(ICON)).toBe(true);
    const etag = current.headers()["etag"] ?? "";
    expect(etag).toMatch(/^"[^"]+"$/);

    for (const path of ["/api/site/favicon?v=stale", "/api/site/favicon"]) {
      const response = await anon.get(path);
      expect(response.status(), path).toBe(200);
      expect(response.headers()["cache-control"], path).toBe("no-cache");
      expect(response.headers()["etag"], path).toBe(etag);
    }

    const revalidated = await anon.get("/api/site/favicon?v=stale", { headers: { "if-none-match": etag } });
    expect(revalidated.status()).toBe(304);
    expect(revalidated.headers()["cache-control"]).toBe("no-cache");
    const versioned = await anon.get(`/api/site/favicon?v=${encodeURIComponent(version)}`, {
      headers: { "if-none-match": etag },
    });
    expect(versioned.status()).toBe(304);
    expect(versioned.headers()["cache-control"]).toBe(IMMUTABLE);
  } finally {
    await anon.dispose();
    await admin.dispose();
  }
});
