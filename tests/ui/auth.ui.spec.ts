import { expect, test } from "@playwright/test";
import { safeAuthRedirect, withAuthRedirect } from "../../apps/web/src/lib/auth-redirect";
import { anonState, ADMIN } from "../helpers/accounts";
import { ready } from "../helpers/hydration";

test.use({ storageState: anonState });

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";

test("login page renders @smoke", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign up" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Forgot?" })).toBeVisible();
});

test("invalid credentials show an error", async ({ page }) => {
  await ready(page, "/login");
  await page.getByLabel("Email").fill("nobody@example.com");
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("login returns to the requested page instead of the admin dashboard", async ({ page }) => {
  await ready(page, "/login?redirect=%2F%3Ffrom%3Dlogin");
  await page.locator("#email").fill(ADMIN.email);
  await page.locator("#password").fill(ADMIN.password);
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL((url) => url.pathname === "/" && url.searchParams.get("from") === "login");
});

test("authentication return targets reject external and recursive redirects", () => {
  expect(safeAuthRedirect("/products?page=2")).toBe("/products?page=2");
  expect(safeAuthRedirect("https://example.com/steal")).toBe("/");
  expect(safeAuthRedirect("//example.com/steal")).toBe("/");
  expect(safeAuthRedirect("/\\example.com/steal")).toBe("/");
  expect(safeAuthRedirect("/login")).toBe("/");
  expect(withAuthRedirect("/login", "/products?page=2")).toBe(
    "/login?redirect=%2Fproducts%3Fpage%3D2",
  );
});

test("signup page renders", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.getByLabel("Name")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Confirm password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
});

test("pending approval errors show the approval status page", async ({ page }) => {
  await page.goto("/login?error=SIGNUP_APPROVAL_REQUIRED");
  await expect(page).toHaveURL(/\/pending-approval$/);
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
});

test("closed social registration errors explain that existing users may sign in", async ({ page }) => {
  await page.goto("/login?error=PUBLIC_SIGNUP_DISABLED");
  await expect(page.getByTestId("auth-error")).toContainText(
    /Public sign-up is closed|공개 가입이 닫혀 있습니다/,
  );
});

test("configured social providers appear on the login page", async ({ page, playwright }) => {
  const admin = await playwright.request.newContext({
    baseURL: base,
    extraHTTPHeaders: { origin: base },
  });
  await admin.post("/api/auth/sign-in/email", {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  try {
    expect(
      (await admin.put("/api/account/auth-config", {
        data: {
          social: {
            google: {
              enabled: true,
              clientId: "dummy-google-client-id",
              clientSecret: "dummy-google-client-secret",
            },
          },
        },
      })).ok(),
    ).toBeTruthy();
    await expect
      .poll(async () => {
        await page.goto("/login");
        return page.getByRole("button", { name: "Continue with Google" }).count();
      }, { timeout: 8_000 })
      .toBe(1);
  } finally {
    await admin.put("/api/account/auth-config", {
      data: { social: { google: { enabled: false } } },
    });
    await admin.dispose();
  }
});

test("forgot-password shows a sent confirmation", async ({ page }) => {
  await ready(page, "/forgot-password");
  // Retry the submit to absorb any first-load hydration timing.
  await expect(async () => {
    await page.getByLabel("Email").fill(ADMIN.email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
});

test("reset-password without a token is disabled", async ({ page }) => {
  await page.goto("/reset-password");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: "Update password" })).toBeDisabled();
});

test("signup creates an account and enters the app @smoke", async ({ page }) => {
  await ready(page, "/signup");
  const email = `signup-${Date.now()}@example.com`;
  await page.getByLabel("Name").fill("New User");
  await page.getByLabel("Email").fill(email);
  // `exact` because "Confirm password" also contains "Password".
  await page.getByLabel("Password", { exact: true }).fill("Podokit3e-Str0ng!pw");
  await page.getByLabel("Confirm password").fill("Podokit3e-Str0ng!pw");
  await page.getByRole("button", { name: "Create account" }).click();
  // Verification off → straight into the app; on → the verify-email page.
  await expect(page).toHaveURL((url) => url.pathname === "/" || url.pathname === "/verify-email");
});

// A typo here is not recoverable the way a mistyped login is: the address has not
// been verified, so the reset link that would rescue the account is sent to an
// inbox the person cannot open.
test("signup refuses a mistyped password confirmation", async ({ page }) => {
  await ready(page, "/signup");
  const email = `signup-mismatch-${Date.now()}@example.com`;
  await page.getByLabel("Name").fill("New User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Podokit3e-Str0ng!pw");
  await page.getByLabel("Confirm password").fill("Podokit3e-Str0ng!pwX");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Passwords do not match")).toBeVisible();
  // Still on the form, and no account was created for that address.
  await expect(page).toHaveURL(/\/signup/);
  const probe = await page.context().request.post("/api/auth/sign-in/email", {
    data: { email, password: "Podokit3e-Str0ng!pw" },
    headers: { origin: new URL(page.url()).origin },
  });
  expect(probe.ok()).toBeFalsy();
});
