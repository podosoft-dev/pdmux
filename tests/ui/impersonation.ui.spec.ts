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

  // Impersonating a normal user leaves the admin-only route group and keeps a
  // visible route back to the original administrator session.
  await expect(page).toHaveURL(/\/account(\/|$)/);
  const stop = page.getByRole("button", { name: "Stop impersonating" });
  await expect(stop).toBeVisible();

  await stop.click();
  await expect(page).toHaveURL(/\/admin(\/|$)/);
  await expect(page.getByRole("button", { name: "Stop impersonating" })).toHaveCount(0);
});
