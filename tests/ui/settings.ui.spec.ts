import { expect, test, type Page } from "@playwright/test";
import { ready } from "../helpers/hydration";
import { setAuthServerConfig, waitForCapabilities } from "../helpers/auth-config";

// admin storageState (project default)

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";

async function saveGeneral(page: Page): Promise<void> {
  const saved = page.waitForResponse(
    (response) => response.url().endsWith("/api/site/settings") && response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  expect((await saved).ok()).toBeTruthy();
  await expect(page.getByText("General settings saved.").last()).toBeVisible();
}

test("settings has General and Authentication tabs", async ({ page }) => {
  await ready(page, "/admin/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "General" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Authentication" })).toBeVisible();
  // General is the default tab: the site name field is shown.
  await expect(page.getByLabel("Site name")).toBeVisible();
});

test("general settings: shows the favicon uploader", async ({ page }) => {
  await ready(page, "/admin/settings");
  await expect(page.getByText("Browser icon (favicon)")).toBeVisible();
  await expect(page.locator('input[type="file"]')).toBeVisible();
});

test("general settings: edit the site name, save, and apply live", async ({ page }) => {
  await ready(page, "/admin/settings");
  const name = page.getByLabel("Site name");
  const original = await name.inputValue();
  await name.fill("PodoKit Test Site");
  await saveGeneral(page);
  // the browser tab title reflects the new name live (no reload)
  await expect(page).toHaveTitle("PodoKit Test Site");
  // restore so other specs start clean
  await name.fill(original);
  await saveGeneral(page);
});

test("settings lists the auth features under the Authentication tab", async ({ page }) => {
  await ready(page, "/admin/settings");
  await page.getByRole("tab", { name: "Authentication" }).click();
  await expect(page.getByText("Email & password")).toBeVisible();
  await expect(page.getByText("Two-factor authentication")).toBeVisible();
  await expect(page.getByText("Breached-password check")).toBeVisible();
  await expect(page.getByText("Magic link")).toBeVisible();
  // each feature carries an explicit status
  await expect(page.getByText("Enabled", { exact: true }).first()).toBeVisible();
});

test("sidebar: back-to-home link returns to the landing page", async ({ page }) => {
  await ready(page, "/admin/settings");
  // the home link lives in the sidebar footer, above the user menu
  await page.getByRole("link", { name: "Back to home" }).click();
  await expect(page).toHaveURL(/\/$/);
  // Landing routes are app-owned, so only verify the shared page shell.
  await expect(page.locator("main").first()).toBeVisible();
});

test("settings is reachable from the sidebar", async ({ page }) => {
  await ready(page, "/admin");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/admin\/settings/);
});

test("admin can toggle a feature flag and it applies live @smoke", async ({ page }) => {
  await ready(page, "/admin/settings");
  await page.getByRole("tab", { name: "Authentication" }).click();
  const toggle = page.getByRole("switch", { name: "Magic link" });
  test.skip((await toggle.count()) === 0, "magic link toggle not present");
  // Serial workers (workers:1) make toggle-then-restore safe for other specs.
  // The starting state is asserted with a reload retry: an earlier spec's auth
  // config write rebuilds the auth instance, and this page can render from the
  // pre-rebuild capabilities for a moment.
  // What this spec is about is that a toggle applies live — not that the flag
  // happens to be on when it starts. Other specs in the suite turn magic link off
  // and on again, so establish the starting state through the API instead of
  // asserting whatever the run left behind, then wait for the server to agree.
  await page.request.put("/api/account/settings", { data: { magicLink: true } });
  await waitForCapabilities(page.request, (caps) => caps.magicLink === true, "magicLink = true");
  await expect(async () => {
    // Re-navigate through the hydration helper rather than reloading raw: a click
    // on the tab before the island hydrates is swallowed, and then the panel that
    // owns this switch never renders at all.
    await ready(page, "/admin/settings");
    await page.getByRole("tab", { name: "Authentication" }).click();
    await expect(toggle).toBeChecked({ timeout: 3000 });
  }).toPass({ timeout: 20_000 });
  await toggle.click();
  await expect(page.getByText("Setting updated")).toBeVisible();
  await expect(toggle).not.toBeChecked(); // capabilities refreshed live
  // restore so the shared magic-link/2FA specs keep their expected state
  await toggle.click();
  await expect(toggle).toBeChecked();
});

test("settings: the require-two-factor toggle is available", async ({ page }) => {
  await ready(page, "/admin/settings");
  await page.getByRole("tab", { name: "Authentication" }).click();
  // The policy toggle renders under Authentication; its enforcement is covered by
  // the require-2fa api/ui specs. Not toggled here — turning it on would gate this
  // admin session.
  await expect(page.getByRole("switch", { name: "Require two-factor" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Sign-up approval" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Automatic logout" })).toBeVisible();
});

test("inactive browser sessions are signed out automatically @smoke", async ({ browser, page: adminPage }) => {
  // Idle sign-out revokes the active server session. Use a dedicated login so
  // this test cannot invalidate the shared admin storageState used by later specs.
  const context = await browser.newContext({ baseURL: base });
  const page = await context.newPage();
  const email = `idle-admin-${Date.now()}@example.com`;
  let signOutRequests = 0;
  let userId = "";
  try {
    const created = await adminPage.request.post("/api/auth/admin/create-user", {
      headers: { origin: base },
      data: { email, password: "Podokit3e-Str0ng!pw", name: "Idle Admin", role: "admin" },
    });
    expect(created.ok()).toBeTruthy();
    userId = ((await created.json()).user?.id ?? "") as string;
    expect(userId).toBeTruthy();

    const signIn = await context.request.post("/api/auth/sign-in/email", {
      headers: { origin: base },
      data: { email, password: "Podokit3e-Str0ng!pw" },
    });
    expect(signIn.ok()).toBeTruthy();

    await setAuthServerConfig(context.request, { sessionIdleTimeoutMinutes: 5 }, {
      key: "sessionIdleTimeoutMinutes",
      value: 5,
    });
    await page.route("**/api/auth/sign-out", async (route) => {
      signOutRequests += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true}' });
    });
    await page.clock.install();

    try {
      await ready(page, "/admin");
      await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    } finally {
      // Keep the loaded page policy at five minutes while restoring the shared
      // DB policy before the isolated session is revoked.
      const restored = await context.request.put("/api/account/auth-config", {
        data: { server: { sessionIdleTimeoutMinutes: null } },
      });
      expect(restored.ok()).toBeTruthy();
    }

    const removed = await adminPage.request.post("/api/auth/admin/remove-user", {
      headers: { origin: base },
      data: { userId },
    });
    expect(removed.ok()).toBeTruthy();
    userId = "";

    await page.clock.fastForward(5 * 60_000 + 1_000);
    await expect.poll(() => signOutRequests).toBe(1);
    await expect(page).toHaveURL(/\/login\?reason=idle$/);
    await expect(page.getByTestId("session-timeout-message")).toBeVisible();
  } finally {
    if (userId) {
      await adminPage.request.post("/api/auth/admin/remove-user", {
        headers: { origin: base },
        data: { userId },
      });
    }
    await context.close();
  }
});
