import { expect, test } from "@playwright/test";
import { ready } from "../helpers/hydration";

// admin storageState (project default) — sessions is an admin-only view
test("sessions table shows the expires column", async ({ page }) => {
  await ready(page, "/admin/sessions");
  await expect(page.getByRole("columnheader", { name: "Expires" })).toBeVisible();
});

test("admin sees user sessions across users", async ({ page }) => {
  await ready(page, "/admin/sessions");
  await expect(page.getByRole("heading", { name: "User sessions" })).toBeVisible();
  // Search by exact address — robust to pagination as sessions accumulate (the
  // admin account alone can fill the first page). This is the across-users view.
  await page.locator("#toolbar-search").fill("user@example.com");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("main").getByText("user@example.com").first()).toBeVisible();
  // row actions are available
  await page.getByRole("row", { name: /user@example.com/ }).first().getByRole("button").click();
  await expect(page.getByRole("menuitem", { name: "Revoke session" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Revoke all for user" })).toBeVisible();
});
