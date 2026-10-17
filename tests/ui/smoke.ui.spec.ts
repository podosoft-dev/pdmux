import { expect, test } from "@playwright/test";
import { paths } from "../helpers/paths";

// Module-agnostic: the app's first screen responds (a page or a redirect to it)
// and renders. Its locator comes from tests/helpers/app-paths.ts.
test("app is reachable @smoke", async ({ page }) => {
  const res = await page.goto(paths.home);
  expect(res?.status()).toBeLessThan(400);
  await expect(paths.homeReady(page)).toBeVisible();
});
