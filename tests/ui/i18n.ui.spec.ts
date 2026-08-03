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

  // Switch back. The choice outlives this test, and specs that run later match
  // English labels — leaving the app in Korean made an unrelated user-management
  // spec fail because its option was rendered as "중재자".
  const restored = initial === "ko" ? /한국어/ : /English/;
  await page.getByRole("button", { name: /^(Language|언어)$/ }).click();
  await page.getByRole("menuitem", { name: restored }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", initial ?? "en");
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

  let initial: string | null = null;
  try {
    await ready(page, "/admin/users");
    initial = await page.locator("html").getAttribute("lang");
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
    // Put the language back: the choice outlives this context, and the specs that
    // run afterwards match English labels.
    await page.getByRole("button", { name: /^(Language|언어)$/ }).click();
    await page.getByRole("menuitem", { name: initial === "ko" ? /한국어/ : /English/ }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", initial ?? "en");
  } finally {
    await context.close();
  }
});
