import { expect, test } from "@playwright/test";
import { clearMailpit, mailpitReachable, waitForLink, waitForOtp } from "../helpers/mailpit";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

test("email one-time code signs a user in", async ({ playwright }) => {
  test.skip(!(await mailpitReachable()), "Mailpit not available");
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const caps = await (await ctx.get("/api/account/capabilities")).json();
  test.skip(!caps?.emailOtp, "email OTP not enabled");
  const email = `otp-${Date.now()}@example.com`;
  await ctx.post("/api/auth/sign-up/email", { data: { email, password: "Podokit3e-Str0ng!pw", name: "Otp" } });
  await clearMailpit();
  const requested = await ctx.post("/api/auth/email-otp/send-verification-otp", { data: { email, type: "sign-in" } });
  expect(requested.ok()).toBeTruthy();
  const otp = await waitForOtp(email);
  const signedIn = await ctx.post("/api/auth/sign-in/email-otp", { data: { email, otp } });
  expect(signedIn.ok()).toBeTruthy();
  const session = await (await ctx.get("/api/auth/get-session")).json();
  expect(session?.user?.email).toBe(email);
  await ctx.dispose();
});

test("organization invitation can be sent and accepted", async ({ playwright }) => {
  const owner = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const caps = await (await owner.get("/api/account/capabilities")).json();
  test.skip(!caps?.organization, "organizations not enabled");
  const pw = "Podokit3e-Str0ng!pw";
  await owner.post("/api/auth/sign-up/email", { data: { email: `owner-${Date.now()}@example.com`, password: pw, name: "Owner" } });
  const orgId = (await (await owner.post("/api/auth/organization/create", { data: { name: "Invco", slug: `invco-${Date.now()}` } })).json())?.id as string;

  // invite a fresh user
  const inviteeEmail = `invitee-${Date.now()}@example.com`;
  const inv = await owner.post("/api/auth/organization/invite-member", { data: { email: inviteeEmail, role: "member", organizationId: orgId } });
  expect(inv.ok()).toBeTruthy();
  const invitationId = (await inv.json())?.id as string;

  // the invitee signs up and accepts
  const invitee = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await invitee.post("/api/auth/sign-up/email", { data: { email: inviteeEmail, password: pw, name: "Invitee" } });
  const accepted = await invitee.post("/api/auth/organization/accept-invitation", { data: { invitationId } });
  expect(accepted.ok()).toBeTruthy();
  await invitee.dispose();

  // the owner now sees two members
  const full = await (await owner.get(`/api/auth/organization/get-full-organization?organizationId=${orgId}`)).json();
  expect((full?.members ?? []).length).toBeGreaterThanOrEqual(2);
  await owner.dispose();
});

test("magic link signs a user in", async ({ playwright }) => {
  test.skip(!(await mailpitReachable()), "Mailpit not available");
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const caps = await (await ctx.get("/api/account/capabilities")).json();
  test.skip(!caps?.magicLink, "magic link not enabled");
  // Use a throwaway account, not the shared ADMIN — a magic-link sign-in can
  // rotate the account's sessions, which would invalidate the seeded storageState.
  const email = `magic-${Date.now()}@example.com`;
  await ctx.post("/api/auth/sign-up/email", { data: { email, password: "Podokit3e-Str0ng!pw", name: "Magic" } });
  await clearMailpit();
  const requested = await ctx.post("/api/auth/sign-in/magic-link", { data: { email, callbackURL: `${base}/admin` } });
  expect(requested.ok()).toBeTruthy();
  const link = await waitForLink(email);
  // Following the emailed link validates the token and sets the session cookie.
  await ctx.get(link, { maxRedirects: 0 });
  const session = await (await ctx.get("/api/auth/get-session")).json();
  expect(session?.user?.email).toBe(email);
  await ctx.dispose();
});

// Follow an emailed auth link (which hits the API to validate) and read the
// token the API hands back on its redirect.
function tokenFromRedirect(location: string): string | null {
  return new URL(location, base).searchParams.get("token");
}

test("password reset delivers an email and updates the password @smoke", async ({ playwright }) => {
  test.skip(!(await mailpitReachable()), "Mailpit not available");
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const email = `reset-${Date.now()}@example.com`;
  const signup = await ctx.post("/api/auth/sign-up/email", { data: { email, password: "Podokit3e-Str0ng!pw", name: "Reset" } });
  expect(signup.ok()).toBeTruthy();
  // With verification on, sign-up returns no session and the new password still
  // can't sign in until confirmed — so only assert sign-in when it's off.
  const verificationOn = !(await signup.json())?.token;

  await clearMailpit();
  const requested = await ctx.post("/api/auth/request-password-reset", { data: { email, redirectTo: `${base}/reset-password` } });
  expect(requested.ok()).toBeTruthy();

  const link = await waitForLink(email);
  const redirected = await ctx.get(link, { maxRedirects: 0 });
  const token = tokenFromRedirect(redirected.headers()["location"] ?? "");
  expect(token, "the reset link resolves to a valid token").toBeTruthy();

  expect((await ctx.post("/api/auth/reset-password", { data: { newPassword: "Podokit3e-N3wStr0ng!pw", token } })).ok()).toBeTruthy();
  if (!verificationOn) {
    expect((await ctx.post("/api/auth/sign-in/email", { data: { email, password: "Podokit3e-N3wStr0ng!pw" } })).ok()).toBeTruthy();
    expect((await ctx.post("/api/auth/sign-in/email", { data: { email, password: "Podokit3e-Str0ng!pw" } })).status()).toBe(401);
  }
  await ctx.dispose();
});

test("email verification blocks sign-in until the address is confirmed", async ({ playwright }) => {
  test.skip(!(await mailpitReachable()), "Mailpit not available");
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const email = `verify-${Date.now()}@example.com`;
  await clearMailpit();
  const signup = await ctx.post("/api/auth/sign-up/email", { data: { email, password: "Podokit3e-Str0ng!pw", name: "Verify", callbackURL: `${base}/admin` } });
  expect(signup.ok()).toBeTruthy();
  // When verification is off, sign-up returns a session — nothing to test here.
  test.skip(Boolean((await signup.json())?.token), "email verification not enabled");

  expect((await ctx.post("/api/auth/sign-in/email", { data: { email, password: "Podokit3e-Str0ng!pw" } })).status()).toBe(403);
  const link = await waitForLink(email);
  await ctx.get(link, { maxRedirects: 0 });
  expect((await ctx.post("/api/auth/sign-in/email", { data: { email, password: "Podokit3e-Str0ng!pw" } })).ok()).toBeTruthy();
  await ctx.dispose();
});
