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

  const bodies: Promise<string>[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.endsWith("/__data.json")) bodies.push(response.text());
  });
  const sidebar = page.locator('[data-sidebar="sidebar"]');
  const stops: Array<[link: string, heading: string]> = [
    ["Users", "Users"],
    ["Sessions", "User sessions"],
    ["Settings", "Settings"],
    ["Overview", "Dashboard"],
  ];
  for (const [link, heading] of stops) {
    await sidebar.getByRole("link", { name: link, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }

  expect(bodies.length).toBeGreaterThanOrEqual(stops.length);
  for (const body of await Promise.all(bodies)) {
    expect(body).not.toContain('"messages"');
    expect(body.length).toBeLessThan(20_000);
  }
  await expect(sidebar.getByRole("link", { name: "Back to home" })).toBeVisible();
});
