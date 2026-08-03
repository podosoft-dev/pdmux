import { expect, test } from "@playwright/test";
import { ADMIN, USER } from "../helpers/accounts";
import { clearSms, smsSinkReachable, waitForSmsOtp } from "../helpers/sms";
import { totpCode } from "../helpers/totp";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

// Accounts are created by the `setup` project (this `api` project depends on it).
test("account/me is 401 when unauthenticated @smoke", async ({ request }) => {
  const res = await request.get("/api/account/me", { headers: origin });
  expect(res.status()).toBe(401);
});

test("rejects a breached password on sign-up", async ({ playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await ctx.post("/api/auth/sign-in/email", { data: { email: ADMIN.email, password: ADMIN.password } });
  const caps = await (await ctx.get("/api/account/capabilities")).json();
  test.skip(!caps?.passwordBreachCheck, "breach check not enabled");
  // "password" is one of the most-breached passwords; Have I Been Pwned rejects it.
  const res = await ctx.post("/api/auth/sign-up/email", {
    data: { name: "Pwned", email: `pwned-${Date.now()}@example.com`, password: "password" },
  });
  expect(res.ok()).toBeFalsy();
  await ctx.dispose();
});

test("phone number: verify with the code delivered to the SMS sink", async ({ playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const caps = await (await ctx.get("/api/account/capabilities")).json();
  test.skip(!caps?.phoneNumber, "phone number not enabled");
  test.skip(!(await smsSinkReachable()), "SMS sink not reachable");
  await clearSms();
  const email = `phone-${Date.now()}@example.com`;
  await ctx.post("/api/auth/sign-up/email", { data: { email, password: "Podokit3e-Str0ng!pw", name: "Phone" } });
  // Unique number per run so the "phone already exists" guard never trips.
  const phone = `+1555${Date.now().toString().slice(-7)}`;

  const sent = await ctx.post("/api/auth/phone-number/send-otp", { data: { phoneNumber: phone } });
  expect(sent.ok()).toBeTruthy();
  const code = await waitForSmsOtp(phone); // read the real code back from the sink

  const verified = await ctx.post("/api/auth/phone-number/verify", {
    data: { phoneNumber: phone, code, updatePhoneNumber: true },
  });
  expect(verified.ok()).toBeTruthy();
  const session = await (await ctx.get("/api/auth/get-session")).json();
  expect(session?.user?.phoneNumber).toBe(phone);
  expect(session?.user?.phoneNumberVerified).toBe(true);
  await ctx.dispose();
});

test("two-factor: enable with a real TOTP code and require it at sign-in @smoke", async ({ playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const caps = await (await ctx.get("/api/account/capabilities")).json();
  test.skip(!caps?.twoFactor, "two-factor not enabled");
  const email = `tf-${Date.now()}@example.com`;
  const pw = "Podokit3e-Str0ng!pw";
  await ctx.post("/api/auth/sign-up/email", { data: { email, password: pw, name: "TF" } });

  // Enable 2FA and confirm it with a code computed from the returned otpauth URI.
  const enable = await (await ctx.post("/api/auth/two-factor/enable", { data: { password: pw } })).json();
  expect(typeof enable.totpURI).toBe("string");
  const verified = await ctx.post("/api/auth/two-factor/verify-totp", { data: { code: totpCode(enable.totpURI) } });
  expect(verified.ok()).toBeTruthy();

  // A fresh sign-in must now be challenged for the second factor (no full session).
  const ctx2 = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const signin = await (await ctx2.post("/api/auth/sign-in/email", { data: { email, password: pw } })).json();
  expect(signin.twoFactorRedirect).toBe(true);
  const session = await (await ctx2.get("/api/auth/get-session")).json();
  expect(session?.user).toBeFalsy();
  await ctx.dispose();
  await ctx2.dispose();
});

test("two-factor: a backup code completes sign-in and is single-use", async ({ playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const caps = await (await ctx.get("/api/account/capabilities")).json();
  test.skip(!caps?.twoFactor, "two-factor not enabled");
  const email = `tf-bc-${Date.now()}@example.com`;
  const pw = "Podokit3e-Str0ng!pw";
  await ctx.post("/api/auth/sign-up/email", { data: { email, password: pw, name: "BC" } });

  // Enable 2FA; the enable response includes the one-time backup codes.
  const enable = await (await ctx.post("/api/auth/two-factor/enable", { data: { password: pw } })).json();
  await ctx.post("/api/auth/two-factor/verify-totp", { data: { code: totpCode(enable.totpURI) } });
  const backupCodes = enable.backupCodes as string[];
  expect(Array.isArray(backupCodes)).toBe(true);
  expect(backupCodes.length).toBeGreaterThan(0);
  const code = backupCodes[0]!;

  // A backup code completes a challenged sign-in (no authenticator needed).
  const ctx2 = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const signin = await (await ctx2.post("/api/auth/sign-in/email", { data: { email, password: pw } })).json();
  expect(signin.twoFactorRedirect).toBe(true);
  const used = await ctx2.post("/api/auth/two-factor/verify-backup-code", { data: { code } });
  expect(used.ok()).toBeTruthy();
  const session = await (await ctx2.get("/api/auth/get-session")).json();
  expect(session?.user?.email).toBe(email);

  // The same code is single-use: a new challenge cannot reuse it.
  const ctx3 = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await ctx3.post("/api/auth/sign-in/email", { data: { email, password: pw } });
  const reuse = await ctx3.post("/api/auth/two-factor/verify-backup-code", { data: { code } });
  expect(reuse.ok()).toBeFalsy();

  await ctx.dispose();
  await ctx2.dispose();
  await ctx3.dispose();
});

test("two-factor: regenerating backup codes invalidates the old set", async ({ playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const caps = await (await ctx.get("/api/account/capabilities")).json();
  test.skip(!caps?.twoFactor, "two-factor not enabled");
  const email = `tf-rg-${Date.now()}@example.com`;
  const pw = "Podokit3e-Str0ng!pw";
  await ctx.post("/api/auth/sign-up/email", { data: { email, password: pw, name: "RG" } });
  const enable = await (await ctx.post("/api/auth/two-factor/enable", { data: { password: pw } })).json();
  await ctx.post("/api/auth/two-factor/verify-totp", { data: { code: totpCode(enable.totpURI) } });
  const oldCode = (enable.backupCodes as string[])[0]!;

  // Regenerating returns a fresh set; the previous codes are replaced.
  const regen = await (await ctx.post("/api/auth/two-factor/generate-backup-codes", { data: { password: pw } })).json();
  const newCodes = regen.backupCodes as string[];
  expect(Array.isArray(newCodes)).toBe(true);
  expect(newCodes.length).toBeGreaterThan(0);
  expect(newCodes).not.toContain(oldCode);

  // An old code no longer completes a challenge; a new one does.
  const ctxOld = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await ctxOld.post("/api/auth/sign-in/email", { data: { email, password: pw } });
  expect((await ctxOld.post("/api/auth/two-factor/verify-backup-code", { data: { code: oldCode } })).ok()).toBeFalsy();

  const ctxNew = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await ctxNew.post("/api/auth/sign-in/email", { data: { email, password: pw } });
  expect((await ctxNew.post("/api/auth/two-factor/verify-backup-code", { data: { code: newCodes[0]! } })).ok()).toBeTruthy();

  await ctx.dispose();
  await ctxOld.dispose();
  await ctxNew.dispose();
});

test("require-2fa: gates an un-enrolled user until they enrol", async ({ playwright }) => {
  const admin = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const caps = await (await admin.get("/api/account/capabilities")).json();
  test.skip(!caps?.twoFactor, "two-factor not enabled");
  await admin.post("/api/auth/sign-in/email", { data: { email: ADMIN.email, password: ADMIN.password } });

  const user = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const email = `rq-${Date.now()}@example.com`;
  const pw = "Podokit3e-Str0ng!pw";
  await user.post("/api/auth/sign-up/email", { data: { email, password: pw, name: "RQ" } });

  try {
    // Turn the policy on (admin; the toggle endpoint is allow-listed by the guard).
    await admin.put("/api/account/settings", { data: { require2fa: true } });
    // The guard caches for a few seconds — poll until the un-enrolled user is gated.
    await expect(async () => {
      expect((await user.get("/api/account/me")).status()).toBe(403);
    }).toPass({ timeout: 8000 });

    // Enrolling restores access.
    const enable = await (await user.post("/api/auth/two-factor/enable", { data: { password: pw } })).json();
    await user.post("/api/auth/two-factor/verify-totp", { data: { code: totpCode(enable.totpURI) } });
    expect((await user.get("/api/account/me")).status()).toBe(200);
  } finally {
    // Always turn it back off so the shared (un-enrolled) sessions aren't gated.
    await admin.put("/api/account/settings", { data: { require2fa: false } });
    await expect(async () => {
      const probe = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
      await probe.post("/api/auth/sign-in/email", { data: { email: USER.email, password: USER.password } });
      const status = (await probe.get("/api/account/me")).status();
      await probe.dispose();
      expect(status).toBe(200);
    }).toPass({ timeout: 8000 });
    await admin.dispose();
    await user.dispose();
  }
});

test("multi-session holds several accounts and switches between them", async ({ playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const caps = await (await ctx.get("/api/account/capabilities")).json();
  test.skip(!caps?.multiSession, "multi-session not enabled");
  const pw = "Podokit3e-Str0ng!pw";
  const a = `ms-a-${Date.now()}@example.com`;
  const b = `ms-b-${Date.now()}@example.com`;
  await ctx.post("/api/auth/sign-up/email", { data: { email: a, password: pw, name: "A" } });
  await ctx.post("/api/auth/sign-up/email", { data: { email: b, password: pw, name: "B" } });
  type Device = { session: { token: string }; user: { email: string } };
  const devices = (await (await ctx.get("/api/auth/multi-session/list-device-sessions")).json()) as Device[];
  expect(devices.length).toBeGreaterThanOrEqual(2);
  // most recent sign-up is active; switch back to the first account
  const first = devices.find((d) => d.user?.email === a);
  expect(first?.session?.token).toBeTruthy();
  await ctx.post("/api/auth/multi-session/set-active", { data: { sessionToken: first!.session.token } });
  const session = await (await ctx.get("/api/auth/get-session")).json();
  expect(session?.user?.email).toBe(a);
  await ctx.dispose();
});

test("a user can sign in with a username", async ({ playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const caps = await (await ctx.get("/api/account/capabilities")).json();
  test.skip(!caps?.username, "username not enabled");
  const email = `uname-${Date.now()}@example.com`;
  const uname = `user${Date.now()}`;
  const pw = "Podokit3e-Str0ng!pw";
  await ctx.post("/api/auth/sign-up/email", { data: { email, password: pw, name: "Uname" } });
  expect((await ctx.post("/api/auth/update-user", { data: { username: uname } })).ok()).toBeTruthy();
  await ctx.dispose();
  const ctx2 = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const signedIn = await ctx2.post("/api/auth/sign-in/username", { data: { username: uname, password: pw } });
  expect(signedIn.ok()).toBeTruthy();
  const session = await (await ctx2.get("/api/auth/get-session")).json();
  expect(session?.user?.username).toBe(uname);
  await ctx2.dispose();
});

test("bearer token authenticates API requests without a cookie", async ({ playwright }) => {
  const email = `bearer-${Date.now()}@example.com`;
  const pw = "Podokit3e-Str0ng!pw";
  const signup = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await signup.post("/api/auth/sign-up/email", { data: { email, password: pw, name: "Bearer" } });
  const signIn = await signup.post("/api/auth/sign-in/email", { data: { email, password: pw } });
  expect(signIn.ok()).toBeTruthy();
  // The bearer plugin accepts the session token as `Authorization: Bearer`. Take it
  // from the session cookie the sign-in set (equivalent to the set-auth-token header).
  const state = await signup.storageState();
  const token = state.cookies.find((c) => c.name.endsWith("session_token"))?.value;
  expect(token, "sign-in set a session token").toBeTruthy();
  await signup.dispose();
  // Fresh context = no session cookie; authenticate purely via the bearer header.
  const api = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  expect((await api.get("/api/account/me")).status()).toBe(401);
  const authed = await api.get("/api/account/me", { headers: { Authorization: `Bearer ${token}` } });
  expect(authed.ok()).toBeTruthy();
  expect((await authed.json())?.email).toBe(email);
  await api.dispose();
});

test("a user can create, list and revoke a personal API key", async ({ playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const caps = await (await ctx.get("/api/account/capabilities")).json();
  test.skip(!caps?.apiKey, "api keys not enabled");
  const email = `apikey-${Date.now()}@example.com`;
  await ctx.post("/api/auth/sign-up/email", { data: { email, password: "Podokit3e-Str0ng!pw", name: "Key" } });

  const created = await ctx.post("/api/auth/api-key/create", { data: { name: "ci" } });
  expect(created.ok()).toBeTruthy();
  const key = (await created.json())?.key as string;
  expect(typeof key).toBe("string");
  expect(key.length).toBeGreaterThan(0);

  const body = (await (await ctx.get("/api/auth/api-key/list")).json()) as { apiKeys: Array<{ id: string; name: string | null }> };
  expect(body.apiKeys.some((k) => k.name === "ci")).toBeTruthy();

  const del = await ctx.post("/api/auth/api-key/delete", { data: { keyId: body.apiKeys[0].id } });
  expect(del.ok()).toBeTruthy();
  await ctx.dispose();
});

test("access control enforces custom role permissions @smoke", async ({ playwright }) => {
  const admin = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await admin.post("/api/auth/sign-in/email", { data: { email: ADMIN.email, password: ADMIN.password } });
  const caps = await (await admin.get("/api/account/capabilities")).json();
  expect(caps.roles).toEqual(expect.arrayContaining(["admin", "moderator", "user"]));

  // A default user lacks the content:create permission.
  const email = `ac-${Date.now()}@example.com`;
  const pw = "Podokit3e-Str0ng!pw";
  const u = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await u.post("/api/auth/sign-up/email", { data: { email, password: pw, name: "AC" } });
  const before = await (await u.post("/api/auth/admin/has-permission", { data: { permissions: { content: ["create"] } } })).json();
  expect(before.success).toBeFalsy();
  const me = await (await u.get("/api/auth/get-session")).json();
  await u.dispose();

  // Promote to moderator; a fresh session now passes the same check.
  const set = await admin.post("/api/auth/admin/set-role", { data: { userId: me.user.id, role: "moderator" } });
  expect(set.ok()).toBeTruthy();
  const u2 = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await u2.post("/api/auth/sign-in/email", { data: { email, password: pw } });
  const after = await (await u2.post("/api/auth/admin/has-permission", { data: { permissions: { content: ["create"] } } })).json();
  expect(after.success).toBeTruthy();
  await u2.dispose();
  await admin.dispose();
});

test("a user can create, list and delete an organization @smoke", async ({ playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const caps = await (await ctx.get("/api/account/capabilities")).json();
  test.skip(!caps?.organization, "organizations not enabled");
  const email = `org-${Date.now()}@example.com`;
  await ctx.post("/api/auth/sign-up/email", { data: { email, password: "Podokit3e-Str0ng!pw", name: "Org" } });

  const slug = `acme-${Date.now()}`;
  const created = await ctx.post("/api/auth/organization/create", { data: { name: "Acme", slug } });
  expect(created.ok()).toBeTruthy();
  const orgId = (await created.json())?.id as string;
  expect(typeof orgId).toBe("string");

  const list = (await (await ctx.get("/api/auth/organization/list")).json()) as Array<{ id: string; slug: string }>;
  expect(list.some((o) => o.slug === slug)).toBeTruthy();

  const del = await ctx.post("/api/auth/organization/delete", { data: { organizationId: orgId } });
  expect(del.ok()).toBeTruthy();
  await ctx.dispose();
});

test("an organization can have a parent and manager members", async ({ playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const caps = await (await ctx.get("/api/account/capabilities")).json();
  test.skip(!caps?.organization, "organizations not enabled");
  const pw = "Podokit3e-Str0ng!pw";
  await ctx.post("/api/auth/sign-up/email", { data: { email: `orgp-${Date.now()}@example.com`, password: pw, name: "Owner" } });

  // A parent org, then a child that points at it.
  const parent = await (await ctx.post("/api/auth/organization/create", { data: { name: "HQ", slug: `hq-${Date.now()}` } })).json();
  const child = await ctx.post("/api/auth/organization/create", {
    data: { name: "Sales", slug: `sales-${Date.now()}`, parentOrganizationId: parent.id },
  });
  expect(child.ok()).toBeTruthy();
  const childId = (await child.json()).id as string;
  const full = await (await ctx.get(`/api/auth/organization/get-full-organization?organizationId=${childId}`)).json();
  expect(full.parentOrganizationId).toBe(parent.id);

  // Add two existing users as managers (role-based → any number).
  const managers: string[] = [];
  for (let i = 0; i < 2; i++) {
    const mCtx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
    const email = `mgr-${Date.now()}-${i}@example.com`;
    await mCtx.post("/api/auth/sign-up/email", { data: { email, password: pw, name: `Mgr${i}` } });
    managers.push((await (await mCtx.get("/api/auth/get-session")).json()).user.id);
    await mCtx.dispose();
  }
  for (const userId of managers) {
    const added = await ctx.post("/api/account/org-member", { data: { userId, organizationId: childId, role: "manager" } });
    expect(added.ok()).toBeTruthy();
  }
  const full2 = await (await ctx.get(`/api/auth/organization/get-full-organization?organizationId=${childId}`)).json();
  const mgrCount = (full2.members ?? []).filter((m: { role: string }) => m.role === "manager").length;
  expect(mgrCount).toBe(2);
  await ctx.dispose();
});

// OIDC discovery + the enabled/disabled behaviour is covered by the front-channel
// test in tests/ui/oidc.ui.spec.ts (which owns toggling the oidcProvider flag), and
// the server-side gate is covered generically by the feature-toggle test above.

test("only admins can change settings @smoke", async ({ playwright }) => {
  const userCtx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await userCtx.post("/api/auth/sign-in/email", { data: { email: USER.email, password: USER.password } });
  const asUser = await userCtx.put("/api/account/settings", { data: { magicLink: false } });
  expect(asUser.status()).toBe(403);
  await userCtx.dispose();
});

test("disabling a feature blocks its endpoint server-side and re-enabling restores it @smoke", async ({ playwright }) => {
  // Uses a fresh admin context (not the shared storageState) so it never rotates
  // the seeded session. Toggles a flag and confirms the feature gate enforces it.
  const admin = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await admin.post("/api/auth/sign-in/email", { data: { email: ADMIN.email, password: ADMIN.password } });
  const caps = await (await admin.get("/api/account/capabilities")).json();
  test.skip(!caps?.magicLink, "magic link not enabled");

  // A disabled feature's endpoint 404s; the gate reads the flag through a short cache.
  const status = (): Promise<number> =>
    admin.post("/api/auth/sign-in/magic-link", { data: { email: "probe@example.com" } }).then((r) => r.status());

  expect((await admin.put("/api/account/settings", { data: { magicLink: false } })).ok()).toBeTruthy();
  await expect.poll(status, { timeout: 8000 }).toBe(404);

  expect((await admin.put("/api/account/settings", { data: { magicLink: true } })).ok()).toBeTruthy();
  await expect.poll(status, { timeout: 8000 }).not.toBe(404);

  await admin.dispose();
});

test("sign-in with a wrong password is rejected", async ({ request }) => {
  const res = await request.post("/api/auth/sign-in/email", {
    headers: origin,
    data: { email: ADMIN.email, password: "definitely-wrong" },
  });
  expect(res.ok()).toBeFalsy();
});

test("ADMIN_EMAILS account has the admin role @smoke", async ({ playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await ctx.post("/api/auth/sign-in/email", { data: { email: ADMIN.email, password: ADMIN.password } });
  const session = await ctx.get("/api/auth/get-session");
  const body = await session.json();
  expect(body?.user?.email).toBe(ADMIN.email);
  expect(body?.user?.role).toBe("admin");
  await ctx.dispose();
});

test("admin can list users, a normal user cannot (403)", async ({ playwright }) => {
  const adminCtx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await adminCtx.post("/api/auth/sign-in/email", { data: { email: ADMIN.email, password: ADMIN.password } });
  const asAdmin = await adminCtx.get("/api/auth/admin/list-users?limit=5");
  expect(asAdmin.ok()).toBeTruthy();
  await adminCtx.dispose();

  const userCtx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await userCtx.post("/api/auth/sign-in/email", { data: { email: USER.email, password: USER.password } });
  const asUser = await userCtx.get("/api/auth/admin/list-users?limit=5");
  expect(asUser.status()).toBe(403);
  await userCtx.dispose();
});
