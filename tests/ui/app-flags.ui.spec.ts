import { expect, test, type Page } from "@playwright/test";
import { APP_FLAG_SETTINGS } from "../../apps/web/src/lib/admin/app-flags";
import { ready } from "../helpers/hydration";

// admin storageState (project default). The Application tab lists the flags of
// the app-owned apps/web/src/lib/admin/app-flags.ts; a generated app has none.
// "only admins can change settings" covers the endpoint's refusal for other users.
const listed = APP_FLAG_SETTINGS.map((setting) => setting.flag);

async function appFlags(page: Page): Promise<Record<string, boolean>> {
  const response = await page.request.get("/api/account/capabilities");
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { appFlags?: Record<string, boolean> }).appFlags ?? {};
}

test("the Application tab shows the flags app-flags.ts lists, and only then", async ({ page }) => {
  await ready(page, "/admin/settings");
  await expect(page.getByRole("tab", { name: "Authentication" })).toBeVisible();
  const tab = page.getByRole("tab", { name: "Application" });
  if (listed.length === 0) {
    await expect(tab).toHaveCount(0);
    return;
  }
  await tab.click();
  const cards = page.locator("[data-app-flag]");
  await expect(cards).toHaveCount(listed.length);
  expect(await cards.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-app-flag"))))
    .toEqual(listed);
  const flags = await appFlags(page);
  for (const flag of listed) {
    expect(flags, `${flag} is in APP_FLAG_DEFAULTS`).toHaveProperty(flag);
    await expect(page.locator(`[data-app-flag="${flag}"]`).getByRole("switch"))
      .toHaveAttribute("aria-checked", String(flags[flag]));
  }
});

test("an application flag switch saves through the settings endpoint", { tag: "@exclusive" }, async ({ page }) => {
  test.skip(listed.length === 0, "app-flags.ts lists no application flags");
  const flag = listed[0] ?? "";
  const original = (await appFlags(page))[flag] === true;
  await ready(page, "/admin/settings");
  await page.getByRole("tab", { name: "Application" }).click();
  const toggle = page.locator(`[data-app-flag="${flag}"]`).getByRole("switch");
  await expect(toggle).toHaveAttribute("aria-checked", String(original));

  try {
    const saved = page.waitForResponse(
      (response) => response.url().endsWith("/api/account/settings") && response.request().method() === "PUT",
    );
    await toggle.click();
    expect((await saved).ok()).toBeTruthy();
    await expect(page.getByText("Setting updated").last()).toBeVisible();
    await expect.poll(async () => (await appFlags(page))[flag]).toBe(!original);

    // The stored value survives a reload.
    await ready(page, "/admin/settings");
    await page.getByRole("tab", { name: "Application" }).click();
    await expect(page.locator(`[data-app-flag="${flag}"]`).getByRole("switch"))
      .toHaveAttribute("aria-checked", String(!original));
  } finally {
    await page.request.put("/api/account/settings", { data: { [flag]: original } });
  }
});
