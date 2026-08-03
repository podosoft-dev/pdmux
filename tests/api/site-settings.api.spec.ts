import { expect, test } from "@playwright/test";
import { ADMIN } from "../helpers/accounts";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

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
