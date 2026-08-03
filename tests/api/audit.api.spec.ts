import { expect, test } from "../helpers/disposable-users";
import { ADMIN, USER } from "../helpers/accounts";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

async function signedIn(
  playwright: import("@playwright/test").PlaywrightWorkerArgs["playwright"],
  account: { email: string; password: string },
) {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await ctx.post("/api/auth/sign-in/email", { data: account });
  return ctx;
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

  const res = await admin.get("/api/audit-logs");
  expect(res.ok()).toBeTruthy();
  const entries = (await res.json()) as Array<{ action: string; actorEmail: string | null; targetLabel: string | null }>;
  const entry = entries.find((e) => e.action === "user.create" && e.targetLabel === email);
  expect(entry, "user.create should be audited with the target").toBeTruthy();
  expect(entry?.actorEmail, "audit entry records the acting admin").toBe(ADMIN.email);

  await admin.post("/api/auth/admin/remove-user", { data: { userId } });
  disposableUsers.forget(userId);
  await admin.dispose();
});

test("the audit log is admin-only", async ({ playwright }) => {
  const admin = await signedIn(playwright, ADMIN);
  test.skip((await admin.get("/api/audit-logs")).status() === 404, "audit-log module not installed");
  await admin.dispose();

  const user = await signedIn(playwright, USER);
  expect((await user.get("/api/audit-logs")).status()).toBe(403);
  await user.dispose();
});

test("sending a verification email is audited", async ({ playwright, disposableUsers }) => {
  const admin = await signedIn(playwright, ADMIN);
  test.skip((await admin.get("/api/audit-logs")).status() === 404, "audit-log module not installed");
  const email = `verif-audit-${Date.now()}@example.com`;
  const created = await admin.post("/api/auth/admin/create-user", {
    data: { email, password: "Podokit3e-Str0ng!pw", name: "VA", role: "user" },
  });
  await disposableUsers.trackResponse(created);
  await admin.post("/api/auth/send-verification-email", { data: { email, callbackURL: `${base}/admin` } });
  const entries = (await (await admin.get("/api/audit-logs")).json()) as Array<{ action: string; targetLabel: string | null }>;
  expect(entries.some((e) => e.action === "auth.verification_sent"), "verification send should be audited").toBeTruthy();
  await admin.dispose();
});

// Audit logging is a DB-backed on/off toggle (auth_config `server`, applied live).
// Runs after the recording tests and restores the flag so nothing else is affected.
test("audit logging honours the DB on/off toggle @smoke", async ({ playwright, disposableUsers }) => {
  const admin = await signedIn(playwright, ADMIN);
  test.skip((await admin.get("/api/audit-logs")).status() === 404, "audit-log module not installed");
  const auditLog = async () => (await (await admin.get("/api/account/capabilities")).json()).auditLog as boolean;
  const recorded = async (label: string) =>
    ((await (await admin.get("/api/audit-logs")).json()) as Array<{ action: string; targetLabel: string | null }>).some(
      (e) => e.action === "user.create" && e.targetLabel === label,
    );
  const createUser = async (email: string): Promise<string> => {
    const response = await admin.post("/api/auth/admin/create-user", {
      data: { email, password: "Podokit3e-Str0ng!pw", name: "T", role: "user" },
    });
    return disposableUsers.trackResponse(response);
  };

  try {
    // OFF → the action is not recorded. Wait past the config-store cache TTL so the
    // audit gate sees the new value (its cache is independent of the capabilities one).
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
    await admin.put("/api/account/auth-config", { data: { server: { auditLog: true } } });
    await admin.dispose();
  }
});
