import { expect, test, type Page } from "@playwright/test";
import { ADMIN, USER, anonState } from "../helpers/accounts";
import { totpCode } from "../helpers/totp";

test.use({ storageState: anonState });

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

async function openHydratedLogin(page: Page, redirect?: string): Promise<void> {
  const query = redirect ? `?redirect=${encodeURIComponent(redirect)}` : "";
  await page.goto(`/login${query}`);
  // The form is server-rendered before Svelte attaches its submit handler. Wait
  // for the client bundle so a fast test click cannot trigger a native reload.
  await page.waitForLoadState("networkidle");
}

async function expectAccountPage(page: Page): Promise<void> {
  await expect(page).toHaveURL((url) => url.pathname === "/account");
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
}

// A disposable account (never the shared admin/user) so enabling 2FA here can't
// invalidate the seeded sessions the other auth specs rely on.
test("two-factor: sign in with a backup code from the login page", async ({ page, playwright }) => {
  const api = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const caps = await (await api.get("/api/account/capabilities")).json();
  test.skip(!caps?.twoFactor, "two-factor not enabled");

  const email = `tf-ui-${Date.now()}@example.com`;
  const pw = "Podokit3e-Str0ng!pw";
  await api.post("/api/auth/sign-up/email", { data: { email, password: pw, name: "UI" } });
  const enable = await (await api.post("/api/auth/two-factor/enable", { data: { password: pw } })).json();
  await api.post("/api/auth/two-factor/verify-totp", { data: { code: totpCode(enable.totpURI) } });
  const backupCode = (enable.backupCodes as string[])[0]!;
  await api.dispose();

  // Password sign-in hands off to the second-factor step (no session yet).
  await openHydratedLogin(page, "/account");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(pw);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  const step = page.getByTestId("two-factor-step");
  await expect(step).toBeVisible();

  // Switch to the backup-code input.
  await page.getByRole("button", { name: "Use a backup code instead" }).click();

  // A wrong code surfaces a localized, mapped message — not better-auth's raw
  // English string ("Invalid backup code").
  await page.getByLabel("Backup code").fill("00000000");
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("isn't valid");
  await expect(page.getByRole("alert")).not.toContainText("Invalid backup code");

  // The real code completes the login.
  await page.getByLabel("Backup code").fill(backupCode);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expectAccountPage(page);
});

test("two-factor: sign in with an authenticator code from the login page", async ({ page, playwright }) => {
  const api = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const caps = await (await api.get("/api/account/capabilities")).json();
  test.skip(!caps?.twoFactor, "two-factor not enabled");

  const email = `tf-totp-ui-${Date.now()}@example.com`;
  const pw = "Podokit3e-Str0ng!pw";
  await api.post("/api/auth/sign-up/email", { data: { email, password: pw, name: "UI" } });
  const enable = await (await api.post("/api/auth/two-factor/enable", { data: { password: pw } })).json();
  await api.post("/api/auth/two-factor/verify-totp", { data: { code: totpCode(enable.totpURI) } });
  await api.dispose();

  await openHydratedLogin(page, "/account");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(pw);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("two-factor-step")).toBeVisible();
  await page.getByLabel("Authentication code").fill(totpCode(enable.totpURI));
  await page.getByRole("button", { name: "Verify", exact: true }).click();

  await expectAccountPage(page);
});

test("require-2fa: a new sign-up is forced through the enrolment page", async ({ page, playwright }) => {
  const admin = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const caps = await (await admin.get("/api/account/capabilities")).json();
  test.skip(!caps?.twoFactor, "two-factor not enabled");
  await admin.post("/api/auth/sign-in/email", { data: { email: ADMIN.email, password: ADMIN.password } });

  const email = `rq-ui-${Date.now()}@example.com`;
  const pw = "Podokit3e-Str0ng!pw";
  try {
    await admin.put("/api/account/settings", { data: { require2fa: true } });
    // A fresh un-enrolled user; poll (via API) until the guard cache picks up the policy.
    const probe = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
    await probe.post("/api/auth/sign-up/email", { data: { email, password: pw, name: "RQUI" } });
    await expect(async () => {
      expect((await probe.get("/api/account/me")).status()).toBe(403);
    }).toPass({ timeout: 8000 });
    await probe.dispose();

    // Signing in toward a protected route lands on the mandatory enrolment page.
    await openHydratedLogin(page, "/account");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(pw);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/setup-2fa/);

    // Complete enrolment entirely through the UI: password → QR + backup codes →
    // authenticator code → activate. The code is computed from the on-page URI.
    await page.getByLabel("Confirm your password").fill(pw);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByTestId("backup-codes")).toBeVisible();
    await expect(page.getByRole("button", { name: "Download" })).toBeVisible();
    const uri = (await page.locator("code").first().innerText()).trim();
    await page.getByRole("checkbox").click();
    await page.getByLabel("3. Enter the 6-digit code").fill(totpCode(uri));
    await page.getByRole("button", { name: "Activate and continue" }).click();

    // Enrolled → the gate lets the regular user into their account page.
    await expectAccountPage(page);

    // An enrolled user who revisits setup is returned to the same non-admin page.
    await page.goto("/setup-2fa");
    await expectAccountPage(page);
  } finally {
    await admin.put("/api/account/settings", { data: { require2fa: false } });
    await expect(async () => {
      const probe = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
      await probe.post("/api/auth/sign-in/email", { data: { email: USER.email, password: USER.password } });
      const status = (await probe.get("/api/account/me")).status();
      await probe.dispose();
      expect(status).toBe(200);
    }).toPass({ timeout: 8000 });
    await admin.dispose();
  }
});

test("account: regenerate backup codes shows a fresh set", async ({ page, playwright }) => {
  const api = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const caps = await (await api.get("/api/account/capabilities")).json();
  test.skip(!caps?.twoFactor, "two-factor not enabled");
  const email = `regen-ui-${Date.now()}@example.com`;
  const pw = "Podokit3e-Str0ng!pw";
  await api.post("/api/auth/sign-up/email", { data: { email, password: pw, name: "RG" } });
  const enable = await (await api.post("/api/auth/two-factor/enable", { data: { password: pw } })).json();
  await api.post("/api/auth/two-factor/verify-totp", { data: { code: totpCode(enable.totpURI) } });
  const backupCode = (enable.backupCodes as string[])[0]!;
  await api.dispose();

  // Sign in (backup-code path) straight to the account page.
  await openHydratedLogin(page, "/account");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(pw);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Use a backup code instead" }).click();
  await page.getByLabel("Backup code").fill(backupCode);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expectAccountPage(page);

  // Security → regenerate backup codes → a fresh set is shown.
  await page.getByRole("button", { name: "Security" }).click();
  await page.locator("#tf-off-pw").fill(pw);
  await page.getByRole("button", { name: "Regenerate backup codes" }).click();
  await expect(page.getByTestId("backup-codes")).toBeVisible();
  await expect(page.getByRole("button", { name: "Download" })).toBeVisible();
});
