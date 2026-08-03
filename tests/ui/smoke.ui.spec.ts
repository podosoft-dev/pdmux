import { expect, test } from "@playwright/test";

// Module-agnostic: the app responds at "/" (a page or a redirect to it).
test("app is reachable @smoke", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.status()).toBeLessThan(400);
  await expect(page.locator("body")).toBeVisible();
});
