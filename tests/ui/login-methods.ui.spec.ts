import { expect, test } from "@playwright/test";
import { anonState } from "../helpers/accounts";
import { ready } from "../helpers/hydration";
import { mailpitReachable, clearMailpit, waitForOtp } from "../helpers/mailpit";

test.use({ storageState: anonState });

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

test("login: magic link shows a sent confirmation", async ({ page, playwright }) => {
  const api = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const caps = await (await api.get("/api/account/capabilities")).json();
  await api.dispose();
  test.skip(!caps?.magicLink, "magic link disabled");

  await ready(page, "/login");
  await page.locator("#email").fill(`ml-${Date.now()}@example.com`);
  await page.getByRole("button", { name: /sign-in link/i }).click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();
});

test("login: an emailed one-time code signs a user in", async ({ page, playwright }) => {
  const api = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const caps = await (await api.get("/api/account/capabilities")).json();
  test.skip(!caps?.emailOtp, "email otp disabled");
  test.skip(!(await mailpitReachable()), "mailpit unreachable");

  const email = `otp-${Date.now()}@example.com`;
  await api.post("/api/auth/sign-up/email", { data: { email, password: "Podokit3e-Str0ng!pw", name: "OTP" } });
  await api.dispose();
  await clearMailpit();

  await ready(page, "/login");
  await page.locator("#email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  const otp = await waitForOtp(email);
  await page.getByLabel("One-time code").fill(otp);
  await page.getByRole("button", { name: "Verify code" }).click();
  await expect(page).toHaveURL(new URL("/", base).toString());
});
