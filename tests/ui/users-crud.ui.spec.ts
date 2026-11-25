import { type Page } from "@playwright/test";
import { expect, test as base, type DisposableUsers } from "../helpers/disposable-users";
import { ready } from "../helpers/hydration";

const origin = process.env.E2E_BASE_URL ?? "http://localhost:5001";

// `dummyGoogle` enables a dummy Google client for one test and disables it again in the
// fixture teardown, which runs even when the test times out; a client left enabled would
// change every later login page in the run.
const test = base.extend<{ dummyGoogle: void }>({
  dummyGoogle: async ({ page }, use) => {
    const google = (enabled: boolean) =>
      page.request.put("/api/account/auth-config", {
        headers: { origin },
        data: {
          social: {
            google: enabled ? { enabled, clientId: "dummy-google-client-id", clientSecret: "dummy-google-client-secret" } : { enabled },
          },
        },
      });
    expect((await google(true)).ok()).toBeTruthy();
    await expect
      .poll(async () => ((await (await page.request.get("/api/account/capabilities")).json()) as { providers: string[] }).providers)
      .toContain("google");
    await use();
    await google(false);
  },
});

// Seed a throwaway user via the API (admin cookies come from storageState) so
// the mutating UI tests don't touch the shared admin/user seed accounts.
async function seedUser(disposableUsers: DisposableUsers, email: string): Promise<string> {
  return disposableUsers.create({ email });
}

// Open the Manage two-pane modal for a seeded user.
async function openManage(page: Page, email: string): Promise<void> {
  await page.locator("#toolbar-search").fill(email);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("row", { name: new RegExp(email) }).getByRole("button").click();
  await page.getByRole("menuitem", { name: "Manage" }).click();
}

test("admin can create a user via the dialog @smoke", async ({ page, disposableUsers }) => {
  await ready(page, "/admin/users");
  const email = `ui-create-${Date.now()}@example.com`;
  await page.getByRole("button", { name: "Add user" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Created");
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByLabel("Password", { exact: true }).fill("Podokit3e-Str0ng!pw");
  await dialog.getByLabel("Confirm password").fill("Podokit3e-Str0ng!pw");
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/admin/create-user") &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Create" }).click();
  await disposableUsers.trackResponse(await created);
  // Wait for the create to settle (dialog closes + list reloads) before searching,
  // otherwise the search input can be refilled by the post-create reload.
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.locator("#toolbar-search").fill(email);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("cell", { name: email })).toBeVisible();
});

test("create rejects mismatched passwords", async ({ page }) => {
  await ready(page, "/admin/users");
  await page.getByRole("button", { name: "Add user" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Mismatch");
  await dialog.getByLabel("Email").fill(`ui-mismatch-${Date.now()}@example.com`);
  await dialog.getByLabel("Password", { exact: true }).fill("Podokit3e-Str0ng!pw");
  await dialog.getByLabel("Confirm password").fill("different999");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog.getByText("Passwords do not match")).toBeVisible();
});

test("manage: edit profile name", async ({ page, disposableUsers }) => {
  await ready(page, "/admin/users");
  const email = `ui-edit-${Date.now()}@example.com`;
  await seedUser(disposableUsers, email);
  await openManage(page, email);
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Edited Name");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("User updated")).toBeVisible();
});

test("manage: set a password (and reject mismatch)", async ({ page, disposableUsers }) => {
  await ready(page, "/admin/users");
  const email = `ui-setpw-${Date.now()}@example.com`;
  await seedUser(disposableUsers, email);
  await openManage(page, email);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Security" }).click();
  await dialog.getByLabel("New password", { exact: true }).fill("Podokit3e-N3wStr0ng!pw");
  await dialog.getByLabel("Confirm new password").fill("different999");
  await dialog.getByRole("button", { name: "Set password" }).click();
  await expect(dialog.getByText("Passwords do not match")).toBeVisible();
  await dialog.getByLabel("Confirm new password").fill("Podokit3e-N3wStr0ng!pw");
  await dialog.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText("Password updated")).toBeVisible();
});

test("manage: ban a user with a reason", async ({ page, disposableUsers }) => {
  await ready(page, "/admin/users");
  const email = `ui-ban-${Date.now()}@example.com`;
  await seedUser(disposableUsers, email);
  await openManage(page, email);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Security" }).click();
  await dialog.getByLabel("Reason (optional)").fill("policy violation");
  await dialog.getByRole("button", { name: "Ban", exact: true }).click();
  await expect(page.getByText("User banned", { exact: true })).toBeVisible();
});

test("manage: revoke a user's session", async ({ page, playwright, disposableUsers }) => {
  await ready(page, "/admin/users");
  const email = `ui-sess-${Date.now()}@example.com`;
  await seedUser(disposableUsers, email);
  // create a session for the user in an isolated context (don't touch the admin cookie)
  const uctx = await playwright.request.newContext({ baseURL: origin, extraHTTPHeaders: { origin } });
  expect((await uctx.post("/api/auth/sign-in/email", { data: { email, password: "Podokit3e-Str0ng!pw" } })).ok()).toBeTruthy();
  await uctx.dispose();
  await openManage(page, email);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Sessions" }).click();
  await dialog.getByRole("button", { name: "Revoke", exact: true }).first().click();
  await expect(page.getByText("Session revoked")).toBeVisible();
});

test("manage: delete a user from the danger zone", async ({ page, disposableUsers }) => {
  await ready(page, "/admin/users");
  const email = `ui-delete-${Date.now()}@example.com`;
  const userId = await seedUser(disposableUsers, email);
  await openManage(page, email);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Danger zone" }).click();
  await dialog.getByRole("button", { name: "Delete" }).click(); // arm
  await dialog.getByRole("button", { name: "Delete" }).click(); // confirm
  await expect(page.getByText("User deleted")).toBeVisible();
  disposableUsers.forget(userId);
  await page.locator("#toolbar-search").fill(email);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("cell", { name: email })).toHaveCount(0);
});

test("users list shows pagination beyond one page", async ({ page, disposableUsers }) => {
  await ready(page, "/admin/users");
  const prefix = `pg-${Date.now()}`;
  for (let i = 0; i < 16; i += 1) {
    await disposableUsers.create({
      email: `${prefix}-${i}@example.com`,
      name: `Page user ${i}`,
    });
  }
  await page.locator("#toolbar-search").fill(prefix);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("16 users")).toBeVisible();
  const nav = page.getByRole("navigation", { name: "pagination" }).first();
  await expect(nav).toBeVisible();
  const secondPage = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/admin/users" && url.searchParams.get("offset") === "15";
  });
  await nav.getByRole("button", { name: "Page 2", exact: true }).first().click();
  expect((await secondPage).ok()).toBeTruthy();
  await expect(page.getByRole("table", { name: "Users" }).locator("tbody tr")).toHaveCount(1);
});

test("manage modal closes from its footer", async ({ page, disposableUsers }) => {
  await ready(page, "/admin/users");
  const email = `ui-close-${Date.now()}@example.com`;
  await seedUser(disposableUsers, email);
  await openManage(page, email);
  // footer Close (a visible button, distinct from the header X) dismisses the modal
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("admin creates a Google-only user without a password, with the email marked verified", { tag: "@exclusive" }, async ({ page, disposableUsers, dummyGoogle: _google }) => {
  await ready(page, "/admin/users");
  const email = `ui-social-${Date.now()}@example.com`;
  await page.getByRole("button", { name: "Add user" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Social Only");
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByTestId("create-social-only").click();
  await expect(dialog.getByLabel("Password", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Sign in with Google only (no password)")).toBeVisible();
  const created = page.waitForResponse(
    (response) => response.url().endsWith("/api/auth/admin/create-user") && response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Create" }).click();
  const response = await created;
  await disposableUsers.trackResponse(response);
  const body = response.request().postDataJSON() as { password?: string; data?: { emailVerified?: boolean } };
  expect(body.password).toBeUndefined();
  expect(body.data?.emailVerified).toBe(true);
  await expect(page.getByRole("dialog")).toBeHidden();

  // The manage panel shows the verification state even with email verification off.
  await openManage(page, email);
  await expect(page.getByRole("dialog").getByTestId("manage-email-verification")).toContainText("Verified");
});
