import { expect, test } from "../helpers/disposable-users";
import { ready } from "../helpers/hydration";
import { clearMailpit, mailpitReachable, waitForLink } from "../helpers/mailpit";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

// Verification badges/actions are gated by the emailVerification capability. The
// seeded suite runs with verification off, so assert the gating here (nothing
// leaks in); the enabled state is covered manually / under a verification run.
test("verification badges stay hidden when the feature is off", async ({ page }) => {
  await ready(page, "/admin/users");
  const caps = await (await page.request.get("/api/account/capabilities")).json();
  test.skip(caps.emailVerification === true, "email verification enabled");
  await expect(page.getByText("Verified", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Unverified", { exact: true })).toHaveCount(0);
});

// Admin can trigger a password-reset email for a user (not verification-gated).
test("admin sends a password reset email to a user", async ({ page, disposableUsers }) => {
  test.skip(!(await mailpitReachable()), "Mailpit not available");
  await ready(page, "/admin/users");
  const email = `admin-reset-${Date.now()}@example.com`;
  await disposableUsers.create({ email, name: "AR" });
  await clearMailpit();
  await page.locator("#toolbar-search").fill(email);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("row", { name: new RegExp(email) }).getByRole("button").click();
  await page.getByRole("menuitem", { name: "Manage" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Security" }).click();
  await dialog.getByRole("button", { name: "Send password reset email" }).click();
  await expect(page.getByText("Password reset email sent")).toBeVisible();
  await waitForLink(email); // a reset email actually arrived for this user
});

test("login shows a verification hint for unverified users", async ({ page, browser }) => {
  const caps = await (await page.request.get("/api/account/capabilities")).json();
  test.skip(caps.emailVerification !== true, "email verification disabled");
  const email = `login-unv-${Date.now()}@example.com`;
  await page.request.post("/api/auth/sign-up/email", { headers: { origin: base }, data: { email, password: "Podokit3e-Str0ng!pw", name: "LU" } });
  const anon = await browser.newContext();
  const p2 = await anon.newPage();
  await p2.goto(`${base}/login`);
  await p2.getByLabel("Email").fill(email);
  await p2.getByLabel("Password").fill("Podokit3e-Str0ng!pw");
  await p2.getByRole("button", { name: "Sign in" }).click();
  await expect(p2.getByRole("link", { name: /resend verification/i })).toBeVisible();
  await anon.close();
});

test("overview omits the unverified-users card when the feature is off", async ({ page }) => {
  await ready(page, "/admin");
  const caps = await (await page.request.get("/api/account/capabilities")).json();
  test.skip(caps.emailVerification === true, "email verification enabled");
  await expect(page.getByText("Unverified users")).toHaveCount(0);
});
