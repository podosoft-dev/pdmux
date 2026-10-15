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
  const filtered = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/auth/admin/list-users" && url.searchParams.get("filterField") === "role";
  });
  await page.getByRole("button", { name: "Search", exact: true }).click();
  expect(new URL((await filtered).url()).searchParams.get("filterValue")).toBe("admin");
  await expect(main.getByRole("cell", { name: "admin@example.com" })).toBeVisible();
  await expect(main.getByRole("cell", { name: "user@example.com" })).toHaveCount(0);
});

test("users toolbar keeps one filter because the server accepts one", async ({ page }) => {
  await ready(page, "/admin/users");
  const roleSelect = page.locator('button[data-slot="select-trigger"]').first();
  const statusSelect = page.locator('button[data-slot="select-trigger"]').nth(1);
  await roleSelect.click();
  await page.getByRole("option", { name: "Admin", exact: true }).click();
  await statusSelect.click();
  await page.getByRole("option", { name: "Banned", exact: true }).click();
  await expect(roleSelect).toContainText("All");
  await expect(statusSelect).toContainText("Banned");

  const filtered = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/auth/admin/list-users" && url.searchParams.get("filterField") === "banned";
  });
  await page.getByRole("button", { name: "Search", exact: true }).click();
  expect(new URL((await filtered).url()).searchParams.get("filterValue")).toBe("true");
});

test("users toolbar can pick the search field", async ({ page }) => {
  await ready(page, "/admin/users");
  const fieldSelect = page.locator('button[data-slot="select-trigger"]').last(); // after the filters
  await fieldSelect.click();
  await page.getByRole("option", { name: "Name", exact: true }).click();
  await expect(fieldSelect).toContainText("Name");
});
