import { expect, test } from "@playwright/test";
import { ready } from "../helpers/hydration";

// admin storageState (project default). The Audit log page is gated by the
// audit-log module; skip when it isn't installed in the generated app.
test("admin can view audit entries when the module is installed", async ({ page }) => {
  await ready(page, "/admin");
  const auditNav = page.getByRole("link", { name: "Audit log" });
  test.skip((await auditNav.count()) === 0, "audit-log module not installed");

  await auditNav.click();
  await expect(page).toHaveURL(/\/admin\/audit/);
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
  // seed sign-ins are audited via the better-auth hook, so an action row is present
  await expect(page.getByText("auth.login").first()).toBeVisible();
});

test("admin filters the audit log on the server", async ({ page }) => {
  await ready(page, "/admin/audit");
  const table = page.getByRole("table", { name: "Audit log" });
  test.skip((await page.getByRole("link", { name: "Audit log" }).count()) === 0, "audit-log module not installed");
  await expect(table.getByText("auth.login").first()).toBeVisible();

  await page.locator('button[data-slot="select-trigger"]').first().click(); // Action filter
  await page.getByRole("option", { name: "auth.login", exact: true }).click();
  await page.locator("#toolbar-search").fill("admin@example.com");
  const filtered = page.waitForResponse((response) =>
    response.url().includes("/api/audit-logs?") &&
    response.url().includes("action=auth.login") &&
    response.url().includes("actor=admin%40example.com"),
  );
  await page.getByRole("button", { name: "Search", exact: true }).click();
  expect((await filtered).ok()).toBeTruthy();

  const actions = table.locator("tbody tr td:nth-child(3)");
  await expect(actions.first()).toHaveText("auth.login");
  for (const text of await actions.allInnerTexts()) expect(text).toBe("auth.login");
  await expect(table.getByText("admin@example.com").first()).toBeVisible();
});

test("admin pages through the audit log", async ({ page }) => {
  await ready(page, "/admin/audit");
  const table = page.getByRole("table", { name: "Audit log" });
  test.skip((await page.getByRole("link", { name: "Audit log" }).count()) === 0, "audit-log module not installed");
  await expect(table.getByRole("row").nth(1)).toBeVisible();
  const next = table.getByRole("button", { name: /next/i });
  test.skip(await next.isDisabled(), "a single page of audit entries");

  const firstPage = await table.locator("tbody tr").first().innerText();
  const pageTwo = page.waitForResponse((response) =>
    response.url().includes("/api/audit-logs?") && response.url().includes("cursor="),
  );
  await next.click();
  expect((await pageTwo).ok()).toBeTruthy();
  await expect(table.locator('[aria-current="page"]')).toHaveText("2");
  expect(await table.locator("tbody tr").first().innerText()).not.toBe(firstPage);
});
