import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../helpers/disposable-users";
import { serverTogglesRestorer } from "../helpers/server-toggles";
import { ADMIN, USER } from "../helpers/accounts";
import { skipUnlessMailReachesMailpit, waitForOtp } from "../helpers/mailpit";
import { totpCode } from "../helpers/totp";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };
const PASSWORD = "Podokit3e-Str0ng!pw";

type Entry = {
  id: string;
  action: string;
  actorEmail: string | null;
  targetId: string | null;
  targetLabel: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

async function signedIn(
  playwright: import("@playwright/test").PlaywrightWorkerArgs["playwright"],
  account: { email: string; password: string },
) {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await ctx.post("/api/auth/sign-in/email", { data: account });
  return ctx;
}

function auditQuery(params: Record<string, string>): string {
  return `/api/audit-logs?${new URLSearchParams(params).toString()}`;
}

// Sign-in methods recorded for the account, oldest first.
async function signInMethods(admin: APIRequestContext, email: string): Promise<unknown[]> {
  const entries = (await (await admin.get(auditQuery({ action: "auth.login", target: email, order: "asc" }))).json()) as Entry[];
  expect(entries.every((entry) => entry.actorEmail === email)).toBe(true);
  return entries.map((entry) => entry.metadata?.method);
}

test("audit log records auth/admin actions", async ({ playwright, disposableUsers }) => {
  const admin = await signedIn(playwright, ADMIN);
  const probe = await admin.get("/api/audit-logs");
  test.skip(probe.status() === 404, "audit-log module not installed");

  // an admin action that flows through better-auth (bypasses the interceptor)
  const email = `audit-${Date.now()}@example.com`;
  const created = await admin.post("/api/auth/admin/create-user", {
    data: { email, password: "Podokit3e-Str0ng!pw", name: "Audit", role: "user" },
  });
  expect(created.ok()).toBeTruthy();
  const userId = await disposableUsers.trackResponse(created);

  const res = await admin.get(auditQuery({ action: "user.create", target: email }));
  expect(res.ok()).toBeTruthy();
  const entries = (await res.json()) as Entry[];
  expect(entries, "user.create should be audited with the target").toHaveLength(1);
  expect(entries[0]?.actorEmail, "audit entry records the acting admin").toBe(ADMIN.email);

  expect((await admin.post("/api/auth/admin/remove-user", { data: { userId } })).ok()).toBeTruthy();
  disposableUsers.forget(userId);
  const removed = (await (await admin.get(auditQuery({ action: "user.delete", target: email }))).json()) as Entry[];
  expect(removed, "user.delete names the removed user by the email it had").toEqual([
    expect.objectContaining({ actorEmail: ADMIN.email, targetId: userId, targetLabel: email }),
  ]);
  await admin.dispose();
});

test("a sign-up and a sign-out are audited with the user", async ({ playwright, disposableUsers }) => {
  const admin = await signedIn(playwright, ADMIN);
  test.skip((await admin.get("/api/audit-logs")).status() === 404, "audit-log module not installed");
  const email = `audit-signup-${Date.now()}@example.com`;
  const visitor = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const signup = await visitor.post("/api/auth/sign-up/email", { data: { email, password: PASSWORD, name: "Signup" } });
  test.skip(signup.status() === 403, "public sign-up is closed");
  const userId = await disposableUsers.trackResponse(signup);
  const entries = async (action: string): Promise<Entry[]> =>
    (await (await admin.get(auditQuery({ action, target: email }))).json()) as Entry[];

  expect(await entries("auth.signup")).toEqual([
    expect.objectContaining({ actorEmail: email, targetId: userId, metadata: { method: "password" } }),
  ]);
  if (!(await visitor.get("/api/auth/get-session").then((response) => response.json()))?.session) {
    expect((await visitor.post("/api/auth/sign-in/email", { data: { email, password: PASSWORD } })).ok()).toBeTruthy();
  }
  expect((await visitor.post("/api/auth/sign-out", { data: {} })).ok()).toBeTruthy();
  expect(await entries("auth.logout"), "the sign-out names the user whose session ended").toEqual([
    expect.objectContaining({ actorEmail: email, targetId: userId }),
  ]);
  await visitor.dispose();
  await admin.dispose();
});

test("the audit log is admin-only", async ({ playwright }) => {
  const admin = await signedIn(playwright, ADMIN);
  test.skip((await admin.get("/api/audit-logs")).status() === 404, "audit-log module not installed");
  await admin.dispose();

  const user = await signedIn(playwright, USER);
  expect((await user.get("/api/audit-logs")).status()).toBe(403);
  expect((await user.get("/api/audit-logs/actions")).status()).toBe(403);
  await user.dispose();
});

test("sending a verification email is audited", async ({ playwright, disposableUsers }) => {
  const admin = await signedIn(playwright, ADMIN);
  test.skip((await admin.get("/api/audit-logs")).status() === 404, "audit-log module not installed");
  const email = `verif-audit-${Date.now()}@example.com`;
  await disposableUsers.create({ email, password: PASSWORD, name: "VA" });
  const sent = async (): Promise<Entry[]> =>
    (await (await admin.get(auditQuery({ action: "auth.verification_sent", target: email }))).json()) as Entry[];

  // Better Auth sends a signed-in user's verification email only to their own address.
  const refused = await admin.post("/api/auth/send-verification-email", { data: { email, callbackURL: `${base}/admin` } });
  expect(refused.status()).toBe(400);
  expect(await sent(), "a refused send is not audited").toEqual([]);

  const user = await signedIn(playwright, { email, password: PASSWORD });
  const own = await user.post("/api/auth/send-verification-email", { data: { email, callbackURL: `${base}/account` } });
  expect(own.ok()).toBeTruthy();
  const entries = await sent();
  expect(entries, "verification send should be audited").toHaveLength(1);
  expect(entries[0]?.actorEmail).toBe(email);
  await user.dispose();
  await admin.dispose();
});

test("the audit log pages with a cursor header through the web proxy", async ({ playwright }) => {
  const admin = await signedIn(playwright, ADMIN);
  test.skip((await admin.get("/api/audit-logs")).status() === 404, "audit-log module not installed");
  // Every sign-in is audited; one more guarantees at least two pages of one entry.
  await (await signedIn(playwright, ADMIN)).dispose();

  const query = { action: "auth.login", actor: ADMIN.email, limit: "1" };
  const first = await admin.get(auditQuery(query));
  expect(first.ok()).toBeTruthy();
  const firstPage = (await first.json()) as Entry[];
  expect(Array.isArray(firstPage)).toBe(true);
  expect(firstPage).toHaveLength(1);
  const cursor = first.headers()["x-next-cursor"];
  expect(cursor, "the proxy relays the next-page cursor").toBeTruthy();

  const second = await admin.get(auditQuery({ ...query, cursor: cursor ?? "" }));
  const secondPage = (await second.json()) as Entry[];
  expect(secondPage).toHaveLength(1);
  expect(secondPage[0]?.id).not.toBe(firstPage[0]?.id);
  expect(Date.parse(secondPage[0]?.createdAt ?? "")).toBeLessThanOrEqual(Date.parse(firstPage[0]?.createdAt ?? ""));

  const ascending = (await (await admin.get(auditQuery({ ...query, limit: "2", order: "asc" }))).json()) as Entry[];
  expect(Date.parse(ascending[0]?.createdAt ?? "")).toBeLessThanOrEqual(Date.parse(ascending[1]?.createdAt ?? ""));
  await admin.dispose();
});

test("the audit log filters on the server and lists its action codes", async ({ playwright }) => {
  const admin = await signedIn(playwright, ADMIN);
  test.skip((await admin.get("/api/audit-logs")).status() === 404, "audit-log module not installed");

  const logins = (await (await admin.get(auditQuery({ action: "auth.login", limit: "100" }))).json()) as Entry[];
  expect(logins.length).toBeGreaterThan(0);
  expect(logins.every((entry) => entry.action === "auth.login")).toBe(true);

  const mine = (await (await admin.get(auditQuery({ actor: ADMIN.email, limit: "100" }))).json()) as Entry[];
  expect(mine.length).toBeGreaterThan(0);
  expect(mine.every((entry) => entry.actorEmail === ADMIN.email)).toBe(true);

  const nobody = await admin.get(auditQuery({ actor: `nobody-${Date.now()}@example.com` }));
  expect(await nobody.json()).toEqual([]);
  expect(nobody.headers()["x-next-cursor"]).toBeUndefined();

  const actions = (await (await admin.get("/api/audit-logs/actions")).json()) as string[];
  expect(actions).toContain("auth.login");
  expect([...actions].sort()).toEqual(actions);
  await admin.dispose();
});

test("the audit log rejects bad paging parameters", async ({ playwright }) => {
  const admin = await signedIn(playwright, ADMIN);
  test.skip((await admin.get("/api/audit-logs")).status() === 404, "audit-log module not installed");
  expect((await admin.get(auditQuery({ limit: "101" }))).status()).toBe(400);
  const badCursor = await admin.get(auditQuery({ cursor: "not-a-cursor" }));
  expect(badCursor.status()).toBe(400);
  expect(((await badCursor.json()) as { error: { code: string } }).error.code).toBe("INVALID_CURSOR");
  await admin.dispose();
});

test("a wrong password is not audited as a sign-in", async ({ playwright, disposableUsers }) => {
  const admin = await signedIn(playwright, ADMIN);
  test.skip((await admin.get("/api/audit-logs")).status() === 404, "audit-log module not installed");
  const email = `audit-password-${Date.now()}@example.com`;
  await disposableUsers.create({ email, password: PASSWORD });

  const visitor = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const wrong = await visitor.post("/api/auth/sign-in/email", { data: { email, password: "Wrong-password-1" } });
  expect(wrong.status()).toBe(401);
  expect(await signInMethods(admin, email), "a failed sign-in leaves no auth.login").toEqual([]);

  expect((await visitor.post("/api/auth/sign-in/email", { data: { email, password: PASSWORD } })).ok()).toBeTruthy();
  expect(await signInMethods(admin, email)).toEqual(["password"]);
  await visitor.dispose();
  await admin.dispose();
});

test("an email code sign-in is audited once", async ({ playwright, disposableUsers }) => {
  await skipUnlessMailReachesMailpit();
  const admin = await signedIn(playwright, ADMIN);
  test.skip((await admin.get("/api/audit-logs")).status() === 404, "audit-log module not installed");
  const caps = await (await admin.get("/api/account/capabilities")).json();
  test.skip(!caps?.emailOtp, "email OTP not enabled");
  const email = `audit-otp-${Date.now()}@example.com`;
  await disposableUsers.create({ email, password: PASSWORD });

  const visitor = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const sent = await visitor.post("/api/auth/email-otp/send-verification-otp", { data: { email, type: "sign-in" } });
  expect(sent.ok()).toBeTruthy();
  const otp = await waitForOtp(email);
  expect((await visitor.post("/api/auth/sign-in/email-otp", { data: { email, otp } })).ok()).toBeTruthy();
  expect(await signInMethods(admin, email)).toEqual(["email-otp"]);
  await visitor.dispose();
  await admin.dispose();
});

test("a two-factor sign-in is audited when the code completes it", async ({ playwright, disposableUsers }) => {
  const admin = await signedIn(playwright, ADMIN);
  test.skip((await admin.get("/api/audit-logs")).status() === 404, "audit-log module not installed");
  const caps = await (await admin.get("/api/account/capabilities")).json();
  test.skip(!caps?.twoFactor, "two-factor not enabled");
  const email = `audit-2fa-${Date.now()}@example.com`;
  await disposableUsers.create({ email, password: PASSWORD });

  const owner = await signedIn(playwright, { email, password: PASSWORD });
  const enable = await (await owner.post("/api/auth/two-factor/enable", { data: { password: PASSWORD } })).json();
  expect((await owner.post("/api/auth/two-factor/verify-totp", { data: { code: totpCode(enable.totpURI) } })).ok()).toBeTruthy();
  expect(await signInMethods(admin, email), "turning on two-factor is not a sign-in").toEqual(["password"]);

  const challenged = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const pending = await (await challenged.post("/api/auth/sign-in/email", { data: { email, password: PASSWORD } })).json();
  expect(pending.twoFactorRedirect).toBe(true);
  expect(await signInMethods(admin, email), "the password step alone is not a sign-in").toEqual(["password"]);

  const verified = await challenged.post("/api/auth/two-factor/verify-totp", { data: { code: totpCode(enable.totpURI) } });
  expect(verified.ok()).toBeTruthy();
  expect(await signInMethods(admin, email)).toEqual(["password", "two-factor-totp"]);
  await owner.dispose();
  await challenged.dispose();
  await admin.dispose();
});

// Audit logging is a DB-backed on/off toggle (auth_config `server`, applied live).
// Runs after the recording tests and restores the flag so nothing else is affected.
test("audit logging honours the DB on/off toggle @smoke", { tag: "@exclusive" }, async ({ playwright, disposableUsers }) => {
  const admin = await signedIn(playwright, ADMIN);
  test.skip((await admin.get("/api/audit-logs")).status() === 404, "audit-log module not installed");
  const auditLog = async () => (await (await admin.get("/api/account/capabilities")).json()).auditLog as boolean;
  const recorded = async (label: string) =>
    ((await (await admin.get(auditQuery({ action: "user.create", target: label }))).json()) as Entry[]).length > 0;
  const createUser = async (email: string): Promise<string> => {
    const response = await admin.post("/api/auth/admin/create-user", {
      data: { email, password: "Podokit3e-Str0ng!pw", name: "T", role: "user" },
    });
    return disposableUsers.trackResponse(response);
  };
  const restoreToggles = await serverTogglesRestorer(admin, ["auditLog"]);

  try {
    // OFF → the action is not recorded. The write refreshes this process's config
    // store, but other API replicas keep their snapshot for the store's cache TTL,
    // so wait it out before relying on the new value.
    await admin.put("/api/account/auth-config", { data: { server: { auditLog: false } } });
    await expect.poll(auditLog, { timeout: 8000 }).toBe(false);
    await new Promise((r) => setTimeout(r, 4000));
    const offEmail = `audit-off-${Date.now()}@example.com`;
    const offId = await createUser(offEmail);
    expect(await recorded(offEmail), "no audit entry while disabled").toBe(false);
    await admin.post("/api/auth/admin/remove-user", { data: { userId: offId } });
    disposableUsers.forget(offId);

    // ON → recording resumes.
    await admin.put("/api/account/auth-config", { data: { server: { auditLog: true } } });
    await expect.poll(auditLog, { timeout: 8000 }).toBe(true);
    await new Promise((r) => setTimeout(r, 4000));
    const onEmail = `audit-on-${Date.now()}@example.com`;
    const onId = await createUser(onEmail);
    expect(await recorded(onEmail), "audit entry recorded once re-enabled").toBe(true);
    await admin.post("/api/auth/admin/remove-user", { data: { userId: onId } });
    disposableUsers.forget(onId);
  } finally {
    await restoreToggles();
    await admin.dispose();
  }
});
