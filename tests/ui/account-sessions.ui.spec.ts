import { signInOnSeparateDevices } from "../helpers/devices";
import { expect, test } from "../helpers/disposable-users";
import { ready } from "../helpers/hydration";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

// Better Auth's /list-sessions returns at most 100 sessions, the first ones the
// database finds, so a browser that signed in after 105 others used to see no
// "Current" row, and "Sign out other sessions" left sessions behind.
test("sessions tab shows the current session and signs out every other one past 100", async ({
  browser,
  playwright,
  disposableUsers,
}) => {
  test.slow();
  const email = `ui-many-sessions-${Date.now()}@example.com`;
  const password = "Podokit3e-Str0ng!pw";
  await disposableUsers.create({ email, password, name: "Many sessions" });
  const statuses = await signInOnSeparateDevices(email, password, 105);
  test.skip(statuses.includes(429), "needs an authentication rate limit above 105 sign-ins per window");
  expect(statuses.every((status) => status === 200)).toBe(true);

  // Sign the browser in last, so its session is the 106th.
  const signIn = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  expect((await signIn.post("/api/auth/sign-in/email", { data: { email, password } })).ok()).toBeTruthy();
  const context = await browser.newContext({ storageState: await signIn.storageState() });
  await context.addCookies([{ name: "locale", value: "en", url: base }]);
  const page = await context.newPage();
  try {
    await ready(page, "/account");
    await page.getByRole("button", { name: "Sessions" }).click();
    await expect(page.getByText("106 sessions", { exact: true })).toBeVisible();
    await expect(page.getByText("Current", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Sign out other sessions" }).click();
    await expect(page.getByText("Signed out other sessions")).toBeVisible();
    await expect(page.getByText("1 sessions", { exact: true })).toBeVisible();
    await expect(page.getByText("Current", { exact: true })).toBeVisible();
    const left = (await (await signIn.get("/api/account/sessions?limit=100")).json()) as { total: number };
    expect(left.total).toBe(1);
  } finally {
    await context.close();
    await signIn.dispose();
  }
});
