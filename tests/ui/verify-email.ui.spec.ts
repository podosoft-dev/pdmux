import { expect, test } from "@playwright/test";
import { anonState } from "../helpers/accounts";
import { ready } from "../helpers/hydration";

test.use({ storageState: anonState });

test("verify-email renders the resend form with the address prefilled", async ({ page }) => {
  await ready(page, "/verify-email?email=someone%40example.com");
  await expect(page.getByLabel("Email")).toHaveValue("someone@example.com");
  await expect(page.getByRole("button", { name: "Resend verification email" })).toBeVisible();
  await expect(page.getByRole("link", { name: /sign in/i })).toBeVisible();
});

test("verify-email shows the link-error alert on a bad link", async ({ page }) => {
  await ready(page, "/verify-email?error=invalid");
  await expect(page.getByRole("alert")).toBeVisible();
});
