import { expect, test } from "../helpers/disposable-users";
import { ready } from "../helpers/hydration";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";

function isSessionList(url: string): boolean {
  return new URL(url).pathname === "/api/admin/sessions";
}

// admin storageState (project default) — sessions is an admin-only view
test("sessions table shows the expires column", async ({ page }) => {
  await ready(page, "/admin/sessions");
  await expect(page.getByRole("columnheader", { name: "Expires" })).toBeVisible();
});

test("sessions page loads one server page without per-user requests or tokens", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  const listed = page.waitForResponse((response) => isSessionList(response.url()));
  await ready(page, "/admin/sessions");
  const response = await listed;

  expect(response.status()).toBe(200);
  const body = (await response.json()) as { items: Array<Record<string, unknown>>; total: number };
  expect(body.items.length).toBeLessThanOrEqual(15);
  for (const item of body.items) expect(item).not.toHaveProperty("token");
  await expect(page.getByRole("table", { name: "User sessions" }).getByRole("row").nth(1)).toBeVisible();
  expect(requested.filter(isSessionList)).toHaveLength(1);
  expect(requested.filter((url) => url.includes("/api/auth/admin/list-user-sessions"))).toEqual([]);
  expect(requested.filter((url) => url.includes("/api/auth/admin/list-users"))).toEqual([]);
});

test("admin sees user sessions across users", async ({ page }) => {
  await ready(page, "/admin/sessions");
  await expect(page.getByRole("heading", { name: "User sessions" })).toBeVisible();
  // Search by exact address — robust to pagination as sessions accumulate (the
  // admin account alone can fill the first page). This is the across-users view.
  const searched = page.waitForResponse(
    (response) => isSessionList(response.url()) && new URL(response.url()).searchParams.get("search") === "user@example.com",
  );
  await page.locator("#toolbar-search").fill("user@example.com");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  expect((await searched).ok()).toBeTruthy();
  await expect(page.getByRole("main").getByText("user@example.com").first()).toBeVisible();
  // row actions are available
  await page.getByRole("row", { name: /user@example.com/ }).first().getByRole("button").click();
  await expect(page.getByRole("menuitem", { name: "Revoke session" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Revoke all for user" })).toBeVisible();
});

test("admin revokes a session by id and only the current page reloads", async ({
  page,
  playwright,
  disposableUsers,
}) => {
  const email = `ui-sess-revoke-${Date.now()}@example.com`;
  await disposableUsers.create({ email, name: "Session Revoke" });
  // Sign the user in on an isolated context so the shared admin cookie is untouched.
  const theirs = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  expect((await theirs.post("/api/auth/sign-in/email", { data: { email, password: "Podokit3e-Str0ng!pw" } })).ok())
    .toBeTruthy();

  await ready(page, "/admin/sessions");
  await page.locator("#toolbar-search").fill(email);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const row = page.getByRole("row", { name: new RegExp(email) });
  await expect(row).toHaveCount(1);

  const revoked = page.waitForResponse(
    (response) => response.request().method() === "DELETE" &&
      new URL(response.url()).pathname.startsWith("/api/admin/sessions/"),
  );
  const reloaded = page.waitForResponse(
    (response) => isSessionList(response.url()) && new URL(response.url()).searchParams.get("search") === email,
  );
  await row.getByRole("button").click();
  await page.getByRole("menuitem", { name: "Revoke session" }).click();
  expect((await revoked).status()).toBe(204);
  const reload = await reloaded;
  expect(new URL(reload.url()).searchParams.get("cursor")).toBeNull();
  await expect(page.getByText("Session revoked")).toBeVisible();
  await expect(row).toHaveCount(0);
  expect(await (await theirs.get("/api/auth/get-session")).json()).toBeNull();
  await theirs.dispose();
});
