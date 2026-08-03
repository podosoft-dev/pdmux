import { expect, test } from "@playwright/test";
import { ready } from "../helpers/hydration";
import { USER } from "../helpers/accounts";

// admin storageState (project default)

test("admin can impersonate a user and stop", async ({ page }) => {
  await ready(page, "/admin/users");
  await page.locator("#toolbar-search").fill(USER.email);
  await page.getByRole("button", { name: "Search", exact: true }).click();

  const row = page.getByRole("row", { name: new RegExp(USER.email) });
  await row.getByRole("button").click();
  await page.getByRole("menuitem", { name: "Impersonate" }).click();

  // Impersonating drops us into the app with a banner offering to stop.
  await expect(page).toHaveURL(/\/admin(\/|$)/);
  const stop = page.getByRole("button", { name: "Stop impersonating" });
  await expect(stop).toBeVisible();

  await stop.click();
  await expect(page.getByRole("button", { name: "Stop impersonating" })).toHaveCount(0);
});
