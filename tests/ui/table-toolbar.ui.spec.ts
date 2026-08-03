import { expect, test } from "@playwright/test";
import { ready } from "../helpers/hydration";

// The shared toolbar: filters + search both commit on the Search button; the
// search field itself is selectable (Email, Name, ...).
test("users toolbar searches only when Search is pressed", async ({ page }) => {
  await ready(page, "/admin/users");
  const main = page.getByRole("main");
  await page.locator("#toolbar-search").fill("admin@example.com");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(main.getByRole("cell", { name: "admin@example.com" })).toBeVisible();
  await expect(main.getByRole("cell", { name: "user@example.com" })).toHaveCount(0);
});

test("users toolbar applies filter + search together on Search", async ({ page }) => {
  await ready(page, "/admin/users");
  const main = page.getByRole("main");
  await page.locator('button[data-slot="select-trigger"]').first().click(); // Role select
  await page.getByRole("option", { name: "Admin", exact: true }).click();
  // Selecting a filter stages it; nothing applies until Search is pressed.
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(main.getByRole("cell", { name: "admin@example.com" })).toBeVisible();
  await expect(main.getByRole("cell", { name: "user@example.com" })).toHaveCount(0);
});

test("users toolbar can pick the search field", async ({ page }) => {
  await ready(page, "/admin/users");
  const fieldSelect = page.locator('button[data-slot="select-trigger"]').last(); // after the filters
  await fieldSelect.click();
  await page.getByRole("option", { name: "Name", exact: true }).click();
  await expect(fieldSelect).toContainText("Name");
});
