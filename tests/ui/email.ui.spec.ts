import { expect, test } from "@playwright/test";
import { anonState } from "../helpers/accounts";
import { ready } from "../helpers/hydration";
import { clearMailpit, mailpitReachable, waitForLink } from "../helpers/mailpit";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

// The reset flow is for signed-out users — run without the seeded session.
test.use({ storageState: anonState });

test("forgot password: request, open the emailed link, set a new password, sign in", async ({ page, playwright }) => {
  test.skip(!(await mailpitReachable()), "Mailpit not available");
  const email = `ui-reset-${Date.now()}@example.com`;
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const signup = await ctx.post("/api/auth/sign-up/email", { data: { email, password: "Podokit3e-Str0ng!pw", name: "UIReset" } });
  expect(signup.ok()).toBeTruthy();
  const verificationOn = !(await signup.json())?.token;
  await ctx.dispose();
  // The happy path ends by signing in; when verification is required that would be
  // blocked, so this UI walkthrough only applies with verification off.
  test.skip(verificationOn, "email verification enabled");
  await clearMailpit();

  await ready(page, "/forgot-password");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText(/reset link is on its way/i)).toBeVisible();

  // Open the emailed link: the API validates it and redirects to the reset page.
  await page.goto(await waitForLink(email));
  await page.waitForLoadState("load");
  await page.waitForTimeout(400);
  // `exact` because "Confirm new password" also contains "New password".
  await page.getByLabel("New password", { exact: true }).fill("Podokit3e-N3wStr0ng!pw");
  // A mismatch is refused, and the single-use token survives it: the same page
  // still accepts the corrected pair below.
  await page.getByLabel("Confirm new password").fill("Podokit3e-N3wStr0ng!pwX");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByText("Passwords do not match")).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);

  await page.getByLabel("Confirm new password").fill("Podokit3e-N3wStr0ng!pw");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("Podokit3e-N3wStr0ng!pw");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(new URL("/", base).toString());
});
