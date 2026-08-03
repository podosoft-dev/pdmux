import { expect, test } from "@playwright/test";
import { anonState } from "../helpers/accounts";
import { ready } from "../helpers/hydration";
import { smsSinkReachable, clearSms, waitForSmsOtp } from "../helpers/sms";

// Each test drives a fresh disposable account (via a real UI login) so the shared
// admin/user sessions are never mutated.
test.use({ storageState: anonState });

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };
const PW = "Podokit3e-Str0ng!pw";

async function loginFresh(page: import("@playwright/test").Page, playwright: import("@playwright/test").PlaywrightWorkerArgs["playwright"], email: string): Promise<void> {
  const api = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await api.post("/api/auth/sign-up/email", { data: { email, password: PW, name: "Acc" } });
  await api.dispose();
  await ready(page, `/login?redirect=${encodeURIComponent("/admin/account")}`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(PW);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/account/);
}

test("account: register and verify a phone number", async ({ page, playwright }) => {
  test.skip(!(await smsSinkReachable()), "sms sink unreachable");
  await loginFresh(page, playwright, `acc-ph-${Date.now()}@example.com`);
  const phoneInput = page.locator("#phone");
  test.skip((await phoneInput.count()) === 0, "phone number feature disabled");

  const phone = `+1555${String(Date.now()).slice(-7)}`;
  await clearSms();
  await phoneInput.fill(phone);
  await page.getByRole("button", { name: "Send code" }).click();
  const code = await waitForSmsOtp(phone);
  await page.getByPlaceholder("Verification code").fill(code);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByText("Phone verified")).toBeVisible();
});

test("account: change email address", async ({ page, playwright }) => {
  await loginFresh(page, playwright, `acc-em-${Date.now()}@example.com`);
  await page.locator("#email").fill(`changed-${Date.now()}@example.com`);
  await page.getByRole("button", { name: "Change email" }).click();
  await expect(page.getByText(/Email address updated|approve the change/)).toBeVisible();
});

test("account: delete my own account", async ({ page, playwright }) => {
  const admin = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await admin.post("/api/auth/sign-in/email", { data: { email: "admin@example.com", password: PW } });
  try {
    // Account deletion is a server toggle (off by default) — enable it, then poll
    // until the capability is live (config store has a short TTL).
    await admin.put("/api/account/auth-config", { data: { server: { allowDelete: true } } });
    await expect(async () => {
      const caps = await (await admin.get("/api/account/capabilities")).json();
      expect(caps.deleteAccount).toBe(true);
    }).toPass({ timeout: 8000 });

    await loginFresh(page, playwright, `acc-del-${Date.now()}@example.com`);
    await page.getByRole("button", { name: "Danger zone" }).click();
    await page.getByRole("button", { name: "Delete account" }).first().click();
    await page.locator("#del-pw").fill(PW);
    // The auth instance rebuilds a few seconds after allowDelete is enabled, so
    // the first delete can be rejected — retry the confirm until it goes through.
    await expect(async () => {
      await page.getByRole("dialog").getByRole("button", { name: "Delete account" }).click();
      await expect(page).toHaveURL(/\/login/, { timeout: 3000 });
    }).toPass({ timeout: 15000 });
  } finally {
    await admin.put("/api/account/auth-config", { data: { server: { allowDelete: false } } });
    await admin.dispose();
  }
});
