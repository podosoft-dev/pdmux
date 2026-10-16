import { expect, test } from "@playwright/test";
import { ready } from "../helpers/hydration";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";

// admin storageState (project default)
test.beforeEach(async ({ page }) => {
  await page.context().addCookies([{ name: "locale", value: "en", url: base }]);
});

test("the first render does not embed the message catalogs", async ({ page }) => {
  const response = await page.request.get("/admin");
  expect(response.ok()).toBeTruthy();
  const html = await response.text();
  expect(html).toContain("Dashboard");
  // A catalog key name only appears in serialized catalog data, never in markup.
  expect(html).not.toContain("namePlaceholder");
});

test("client navigation keeps the server checks without resending messages", async ({ page }) => {
  await ready(page, "/admin");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  const sidebar = page.locator('[data-sidebar="sidebar"]');
  const stops: Array<[link: string, path: string, heading: string]> = [
    ["Users", "/admin/users", "Users"],
    ["Sessions", "/admin/sessions", "User sessions"],
    ["Settings", "/admin/settings", "Settings"],
    ["Overview", "/admin", "Dashboard"],
  ];
  for (const [link, path, heading] of stops) {
    // Read each body before the next click: once the page navigates on, the
    // previous response body is no longer available.
    const data = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `${path}/__data.json`,
    );
    await sidebar.getByRole("link", { name: link, exact: true }).click();
    const body = await (await data).text();
    expect(body).not.toContain('"messages"');
    expect(body.length).toBeLessThan(20_000);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }

  await expect(sidebar.getByRole("link", { name: "Back to home" })).toBeVisible();
});
