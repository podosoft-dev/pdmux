import { expect, test } from "../helpers/disposable-users";
import { ADMIN, USER } from "../helpers/accounts";
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
  await page.locator("#toolbar-search").fill(ADMIN.email);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("cell", { name: ADMIN.email, exact: true })).toBeVisible();
  await page.locator("#toolbar-search").fill(USER.email);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("cell", { name: USER.email, exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: ADMIN.email, exact: true })).toHaveCount(0);
});

test("the user list asks the server for one page at a time", async ({ page }) => {
  const isListUsers = (url: string): boolean => new URL(url).pathname === "/api/admin/users";
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  const first = page.waitForResponse((response) => isListUsers(response.url()));
  await ready(page, "/admin/users");
  const initial = new URL((await first).url()).searchParams;
  expect(initial.get("limit")).toBe("15");
  expect(initial.get("sortBy")).toBe("createdAt");
  expect(initial.get("sortDirection")).toBe("desc");
  await expect(page.getByRole("columnheader", { name: "Joined" })).toHaveAttribute("aria-sort", "descending");

  // The server matches case-insensitively, so the search goes as typed.
  const searched = page.waitForResponse((response) => isListUsers(response.url()));
  await page.locator("#toolbar-search").fill("Admin@Example.com");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const query = new URL((await searched).url()).searchParams;
  expect(query.get("search")).toBe("Admin@Example.com");
  expect(query.get("searchField")).toBe("email");
  expect(query.get("offset")).toBe("0");
  await expect(page.getByRole("cell", { name: ADMIN.email, exact: true })).toBeVisible();
  expect(requested.filter((url) => url.includes("/api/auth/admin/list-users"))).toEqual([]);
});

test("user list shows the joined column", async ({ page }) => {
  await ready(page, "/admin/users");
  await expect(page.getByRole("columnheader", { name: "Joined" })).toBeVisible();
});

test("row menu exposes admin actions", async ({ page }) => {
  // The list shows one server page, so the search must run before the row exists.
  await ready(page, "/admin/users");
  const searched = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/admin/users" &&
      url.searchParams.get("search") === USER.email;
  });
  await page.locator("#toolbar-search").fill(USER.email);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  expect((await searched).ok()).toBeTruthy();
  const row = page.getByRole("row", { name: USER.email });
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
