import { expect, test } from "@playwright/test";
import { ready } from "../helpers/hydration";

// Full passkey round trip on a throwaway account — never touches the shared admin.
test.use({ storageState: { cookies: [], origins: [] } });

test("register a passkey and sign in with it", async ({ page, baseURL }) => {
  const origin = { origin: baseURL ?? "" };
  // A virtual authenticator answers both the register (create) and sign-in (get)
  // WebAuthn ceremonies without hardware.
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable");
  await client.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  // Sign up a throwaway user (shares the page's cookie jar) and register a passkey.
  const email = `pk-${Date.now()}@example.com`;
  const pw = "Podokit3e-Str0ng!pw";
  const signup = await page.context().request.post("/api/auth/sign-up/email", { data: { email, password: pw, name: "PK" }, headers: origin });
  expect(signup.ok(), await signup.text()).toBeTruthy();

  await ready(page, "/admin/account");
  await page.getByRole("button", { name: "Security" }).click();
  const addBtn = page.getByRole("button", { name: "Add passkey" });
  test.skip((await addBtn.count()) === 0, "passkeys not enabled");
  await page.getByLabel("Name", { exact: true }).fill("My device");
  await addBtn.click();
  await expect(page.getByText("Passkey added")).toBeVisible();

  // Sign out, then sign back in using only the passkey.
  await page.context().request.post("/api/auth/sign-out", { headers: origin });
  await ready(page, "/login");
  await page.getByRole("button", { name: "Use a passkey" }).click();
  await expect(page).toHaveURL(new URL("/", baseURL).toString());
});
