import { expect, test } from "@playwright/test";

// PDMUX's root is the terminal workspace, whose toolbar replaces a document heading.
test("app is reachable @smoke", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.status()).toBeLessThan(400);
  await expect(page.locator("main")).toBeVisible();
  await expect(page.getByTestId("dashboard-shell")).toBeVisible();
  await expect(page.locator("[data-pdmux-grid]")).toBeVisible();
});
