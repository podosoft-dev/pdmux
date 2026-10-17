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

  // Impersonating a normal user leaves the admin-only route group. Where the
  // application-owned users page lands is the application's choice; the managed
  // account page always offers the route back to the administrator session.
  await expect(page).not.toHaveURL(/\/admin\/users/);
  await ready(page, "/account");
  await expect(page.getByText(`Impersonating ${USER.email}`)).toBeVisible();
  const stop = page.getByRole("button", { name: "Stop impersonating" });
  await expect(stop).toBeVisible();

  await stop.click();
  await expect(page).toHaveURL(/\/admin(\/|$)/);
  await expect(page.getByRole("button", { name: "Stop impersonating" })).toHaveCount(0);
});
