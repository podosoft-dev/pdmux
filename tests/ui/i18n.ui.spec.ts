import { expect, test } from "@playwright/test";
import { ADMIN, adminState, anonState } from "../helpers/accounts";
import { ready } from "../helpers/hydration";

test.use({ storageState: anonState });

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

test("language switch updates messages and <html lang>", async ({ page }) => {
  await ready(page, "/login");
  const initial = await page.locator("html").getAttribute("lang");
  await page.getByRole("button", { name: /^(Language|언어)$/ }).click();
  if (initial === "ko") {
    await page.getByRole("menuitem", { name: /English/ }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  } else {
    await page.getByRole("menuitem", { name: /한국어/ }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "ko");
    await expect(page.getByRole("button", { name: "로그인", exact: true })).toBeVisible();
  }
});

test("explicit English overrides a Korean site fallback", async ({ page, playwright }) => {
  const admin = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await admin.post("/api/auth/sign-in/email", {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  const previous = await (await admin.get("/api/site/settings")).json() as { locale?: string };

  try {
    expect((await admin.put("/api/site/settings", { data: { locale: "ko" } })).ok()).toBeTruthy();
    await page.context().addCookies([{ name: "locale", value: "en", url: base }]);
    await ready(page, "/login");

    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  } finally {
    await admin.put("/api/site/settings", { data: { locale: previous.locale ?? "en" } });
    await admin.dispose();
  }
});

test("managed admin labels react to locale changes", async ({ browser }) => {
  const context = await browser.newContext({ storageState: adminState });
  const page = await context.newPage();

  try {
    await ready(page, "/admin/users");
    const initial = await page.locator("html").getAttribute("lang");
    if (initial === "ko") {
      await expect(page.getByRole("columnheader", { name: "이메일" })).toBeVisible();
      await page.getByRole("button", { name: "언어" }).click();
      await page.getByRole("menuitem", { name: /English/ }).click();
      await expect(page.getByRole("columnheader", { name: "Email" })).toBeVisible();
    } else {
      await expect(page.getByRole("columnheader", { name: "Email" })).toBeVisible();
      await page.getByRole("button", { name: "Language" }).click();
      await page.getByRole("menuitem", { name: /한국어/ }).click();
      await expect(page.getByRole("columnheader", { name: "이메일" })).toBeVisible();
    }
  } finally {
    await context.close();
  }
});
