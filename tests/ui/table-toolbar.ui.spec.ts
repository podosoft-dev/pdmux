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
    return url.pathname === "/api/admin/users" && url.searchParams.get("role") === "admin";
  });
  await page.getByRole("button", { name: "Search", exact: true }).click();
  expect((await filtered).ok()).toBeTruthy();
  await expect(main.getByRole("cell", { name: "admin@example.com" })).toBeVisible();
  await expect(main.getByRole("cell", { name: "user@example.com" })).toHaveCount(0);
});

test("users toolbar combines the role and status filters", async ({ page }) => {
  await ready(page, "/admin/users");
  const main = page.getByRole("main");
  const roleSelect = page.locator('button[data-slot="select-trigger"]').first();
  const statusSelect = page.locator('button[data-slot="select-trigger"]').nth(1);
  await roleSelect.click();
  await page.getByRole("option", { name: "Admin", exact: true }).click();
  await statusSelect.click();
  await page.getByRole("option", { name: "Active", exact: true }).click();
  await expect(roleSelect).toContainText("Admin");
  await expect(statusSelect).toContainText("Active");

  const filtered = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/admin/users" &&
      url.searchParams.get("role") === "admin" &&
      url.searchParams.get("status") === "active";
  });
  await page.getByRole("button", { name: "Search", exact: true }).click();
  expect((await filtered).ok()).toBeTruthy();
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

test("users toolbar keeps the search box usable at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page, "/admin/users");
  const input = await page.locator("#toolbar-search").boundingBox();
  const field = await page.locator('button[data-slot="select-trigger"]').last().boundingBox();
  const button = await page.getByRole("button", { name: "Search", exact: true }).boundingBox();
  if (!input || !field || !button) throw new Error("expected the toolbar to render");
  // The input wraps below the field select instead of shrinking beside it.
  expect(input.width).toBeGreaterThanOrEqual(192);
  expect(input.y).toBeGreaterThan(field.y + field.height);
  expect(Math.abs(input.y + input.height / 2 - (button.y + button.height / 2))).toBeLessThan(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBe(0);
});

test("users toolbar keeps the desktop search box on one row", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await ready(page, "/admin/users");
  const input = await page.locator("#toolbar-search").boundingBox();
  const field = await page.locator('button[data-slot="select-trigger"]').last().boundingBox();
  if (!input || !field) throw new Error("expected the toolbar to render");
  expect(input.width).toBe(320);
  expect(Math.abs(input.y + input.height / 2 - (field.y + field.height / 2))).toBeLessThan(1);
});
