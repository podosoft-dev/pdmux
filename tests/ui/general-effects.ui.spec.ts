import { expect, test, type Page } from "@playwright/test";
import { anonState } from "../helpers/accounts";
import { ready } from "../helpers/hydration";

// Verifies that the General settings actually take effect (not just persist).
// The admin storageState (project default) drives the toggles; a fresh anonymous
// context checks the public-facing result. Serial workers (workers:1) make the
// toggle-then-restore pattern safe for the rest of the suite; restores run in a
// `finally` so a mid-test failure still leaves the shared site settings clean.

async function saveGeneral(
  page: Page,
  prepare?: () => Promise<void>,
  expected?: Record<string, string>,
): Promise<void> {
  const button = page.getByRole("button", { name: "Save changes" });
  await expect(async () => {
    await prepare?.();
    const saved = page.waitForResponse(
      (response) => response.url().endsWith("/api/site/settings") && response.request().method() === "PUT",
      { timeout: 3_000 },
    );
    await button.click();
    const response = await saved;
    expect(response.ok()).toBeTruthy();
    if (expected) expect(await response.json()).toMatchObject(expected);
  }).toPass({ timeout: 10_000 });
  await expect(page.getByText("General settings saved.").last()).toBeVisible();
}

test("general: empty locale displays the application default", async ({ page }) => {
  await ready(page, "/admin/settings");
  const origin = new URL(page.url()).origin;
  const settingsUrl = `${origin}/api/site/settings`;
  const previous = await (await page.request.get(settingsUrl)).json() as { locale?: string };

  try {
    expect((await page.request.put(settingsUrl, { data: { locale: "" } })).ok()).toBeTruthy();
    await ready(page, "/admin/settings");
    await expect(page.locator("#locale")).toContainText("English");
  } finally {
    await page.request.put(settingsUrl, { data: { locale: previous.locale ?? "" } });
  }
});

test("general: footer text and links render on public pages", async ({ page, browser }) => {
  await ready(page, "/admin/settings");
  const origin = new URL(page.url()).origin;
  const footer = page.getByLabel("Footer text");
  const support = page.getByLabel("Support email");
  const origFooter = await footer.inputValue();
  const origSupport = await support.inputValue();
  await saveGeneral(
    page,
    async () => {
      await footer.fill("© 2026 PodoKit Test");
      await support.fill("help@example.com");
    },
    { footerText: "© 2026 PodoKit Test", supportEmail: "help@example.com" },
  );
  try {
    const ctx = await browser.newContext({ storageState: anonState });
    const anon = await ctx.newPage();
    await anon.goto(`${origin}/login`);
    await expect(anon.getByText("© 2026 PodoKit Test")).toBeVisible();
    await expect(anon.getByRole("link", { name: "Support" })).toHaveAttribute("href", "mailto:help@example.com");
    await ctx.close();
  } finally {
    await ready(page, "/admin/settings");
    await saveGeneral(
      page,
      async () => {
        await page.getByLabel("Footer text").fill(origFooter);
        await page.getByLabel("Support email").fill(origSupport);
      },
      { footerText: origFooter, supportEmail: origSupport },
    );
  }
});

test("general: maintenance mode holds non-admins on the maintenance page", async ({ page, browser }) => {
  await ready(page, "/admin/settings");
  const origin = new URL(page.url()).origin;
  await page.getByRole("switch", { name: "Maintenance mode" }).click();
  await saveGeneral(page);
  try {
    const ctx = await browser.newContext({ storageState: anonState });
    const anon = await ctx.newPage();
    await anon.goto(`${origin}/`);
    await expect(anon).toHaveURL(/\/maintenance$/);
    await expect(anon.getByRole("heading", { name: "Under maintenance" })).toBeVisible();
    await ctx.close();
    // the admin is not held back
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  } finally {
    await ready(page, "/admin/settings");
    const t = page.getByRole("switch", { name: "Maintenance mode" });
    if (await t.isChecked()) {
      await t.click();
      await saveGeneral(page);
    }
  }
});

test("general: closing sign-up redirects /signup and hides the link", async ({ page, browser }) => {
  await ready(page, "/admin/settings");
  const origin = new URL(page.url()).origin;
  await page.getByRole("switch", { name: "Allow public sign-up" }).click();
  await saveGeneral(page);
  try {
    const ctx = await browser.newContext({ storageState: anonState });
    const anon = await ctx.newPage();
    await anon.goto(`${origin}/signup`);
    await expect(anon).toHaveURL(/\/login/);
    await expect(anon.getByRole("link", { name: "Sign up" })).toHaveCount(0);
    await ctx.close();
  } finally {
    await ready(page, "/admin/settings");
    const t = page.getByRole("switch", { name: "Allow public sign-up" });
    if (!(await t.isChecked())) {
      await t.click();
      await saveGeneral(page);
    }
  }
});
