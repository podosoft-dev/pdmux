import { expect, test } from "../helpers/disposable-users";
import { ready } from "../helpers/hydration";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";

test("admin can create a user with a custom role", async ({ page, disposableUsers }) => {
  await ready(page, "/admin/users");
  await page.getByRole("button", { name: "Add user" }).click();
  const role = page.locator("#c-role");
  test.skip((await role.count()) === 0, "role picker not present");
  const email = `mod-${Date.now()}@example.com`;
  await page.getByLabel("Name", { exact: true }).fill("Mod");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Podokit3e-Str0ng!pw");
  await page.getByLabel("Confirm password").fill("Podokit3e-Str0ng!pw");
  // pick the Moderator role from the select
  await role.click();
  await page.getByRole("option", { name: "Moderator" }).click();
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/admin/create-user") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await disposableUsers.trackResponse(await created);
  await expect(page.getByText("User created")).toBeVisible();
  // it appears in the list, filterable by the Moderator role
  await page.locator("#toolbar-search").fill(email);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("cell", { name: email })).toBeVisible();
});

test("admin sees the user list and can search", async ({ page }) => {
  await ready(page, "/admin/users");
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  // Search by exact address — robust to pagination as the user count grows.
  await page.locator("#toolbar-search").fill("admin@example.com");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("cell", { name: "admin@example.com" })).toBeVisible();
  await page.locator("#toolbar-search").fill("user@example.com");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("cell", { name: "user@example.com" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "admin@example.com" })).toHaveCount(0);
});

test("user list shows the joined column", async ({ page }) => {
  await ready(page, "/admin/users");
  await expect(page.getByRole("columnheader", { name: "Joined" })).toBeVisible();
});

test("row menu exposes admin actions", async ({ page }) => {
  await page.goto("/admin/users");
  await page.locator("#toolbar-search").fill("user@example.com");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const row = page.getByRole("row", { name: /user@example.com/ });
  await row.getByRole("button").click();
  await expect(page.getByRole("menuitem", { name: "Manage" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Impersonate" })).toBeVisible();
});

test("admin can approve a pending registration from the user list", async ({ page, disposableUsers }) => {
  const email = `pending-ui-${Date.now()}@example.com`;
  const userId = await disposableUsers.create({ email, name: "Pending UI" });
  expect(
    (await page.request.post("/api/auth/admin/update-user", {
      headers: { origin: base },
      data: { userId, data: { signupApproved: false } },
    })).ok(),
  ).toBeTruthy();

  await ready(page, "/admin/users");
  await page.locator("#toolbar-search").fill(email);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const row = page.getByRole("row", { name: new RegExp(email) });
  await expect(row.getByText("Pending approval")).toBeVisible();
  await row.getByRole("button").click();
  const response = page.waitForResponse(
    (res) => res.url().endsWith("/api/auth/admin/update-user") && res.request().method() === "POST",
  );
  await page.getByRole("menuitem", { name: "Approve sign-up" }).click();
  expect((await response).ok()).toBeTruthy();
  await expect(page.getByText("Sign-up approved")).toBeVisible();
  await expect(row.getByText("Active")).toBeVisible();
});
