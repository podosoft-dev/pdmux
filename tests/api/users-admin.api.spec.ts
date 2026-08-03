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

test("admin can create a user, set its password, and remove it", async ({ playwright, disposableUsers }) => {
  const admin = await signedIn(playwright, ADMIN);
  const email = `api-crud-${Date.now()}@example.com`;

  const created = await admin.post("/api/auth/admin/create-user", {
    data: { email, password: "Podokit3e-Str0ng!pw", name: "API CRUD", role: "user" },
  });
  expect(created.ok()).toBeTruthy();
  const id = await disposableUsers.trackResponse(created);
  expect(id).toBeTruthy();

  const setPw = await admin.post("/api/auth/admin/set-user-password", {
    data: { userId: id, newPassword: "Podokit3e-N3wStr0ng!pw" },
  });
  expect(setPw.ok()).toBeTruthy();

  // the new password works
  const fresh = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const signin = await fresh.post("/api/auth/sign-in/email", { data: { email, password: "Podokit3e-N3wStr0ng!pw" } });
  expect(signin.ok()).toBeTruthy();
  await fresh.dispose();

  const removed = await admin.post("/api/auth/admin/remove-user", { data: { userId: id } });
  expect(removed.ok()).toBeTruthy();
  disposableUsers.forget(id);
  await admin.dispose();
});

test("a normal user cannot create users (403)", async ({ playwright }) => {
  const user = await signedIn(playwright, USER);
  const res = await user.post("/api/auth/admin/create-user", {
    data: { email: `nope-${Date.now()}@example.com`, password: "Podokit3e-Str0ng!pw", name: "Nope", role: "user" },
  });
  expect(res.status()).toBe(403);
  await user.dispose();
});

test("admin can list and revoke a user's sessions", async ({ playwright, disposableUsers }) => {
  const admin = await signedIn(playwright, ADMIN);
  const email = `api-sess-${Date.now()}@example.com`;
  const created = await admin.post("/api/auth/admin/create-user", {
    data: { email, password: "Podokit3e-Str0ng!pw", name: "API Sess", role: "user" },
  });
  const userId = await disposableUsers.trackResponse(created);

  // the user signs in -> creates a session
  const theirs = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  expect((await theirs.post("/api/auth/sign-in/email", { data: { email, password: "Podokit3e-Str0ng!pw" } })).ok()).toBeTruthy();
  await theirs.dispose();

  const listed = await admin.post("/api/auth/admin/list-user-sessions", { data: { userId } });
  expect(listed.ok()).toBeTruthy();
  expect(((await listed.json())?.sessions ?? []).length).toBeGreaterThan(0);

  const revoked = await admin.post("/api/auth/admin/revoke-user-sessions", { data: { userId } });
  expect(revoked.ok()).toBeTruthy();
  await admin.post("/api/auth/admin/remove-user", { data: { userId } });
  disposableUsers.forget(userId);
  await admin.dispose();
});

test("revokeOtherSessions keeps the current session valid", async ({ playwright, disposableUsers }) => {
  // Use a throwaway account so we don't revoke the shared USER's ui storageState.
  const admin = await signedIn(playwright, ADMIN);
  const email = `api-revoke-others-${Date.now()}@example.com`;
  const created = await admin.post("/api/auth/admin/create-user", {
    data: { email, password: "Podokit3e-Str0ng!pw", name: "RO", role: "user" },
  });
  await disposableUsers.trackResponse(created);
  await admin.dispose();

  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await ctx.post("/api/auth/sign-in/email", { data: { email, password: "Podokit3e-Str0ng!pw" } });
  expect((await ctx.post("/api/auth/revoke-other-sessions")).ok()).toBeTruthy();
  const after = await ctx.get("/api/auth/get-session");
  expect((await after.json())?.user?.email).toBe(email); // still signed in
  await ctx.dispose();
});

test("sessions record a client IP (forwarded through the proxy)", async ({ playwright }) => {
  const ctx = await signedIn(playwright, ADMIN);
  const res = await ctx.get("/api/auth/list-sessions");
  const sessions = (await res.json()) as Array<{ ipAddress?: string | null }>;
  expect(sessions.length).toBeGreaterThan(0);
  expect(sessions[0]?.ipAddress).toBeTruthy();
  expect(sessions[0]?.ipAddress).not.toBe("0000:0000:0000:0000:0000:0000:0000:0000");
  await ctx.dispose();
});

test("account capabilities reports optional-feature flags", async ({ playwright }) => {
  const ctx = await signedIn(playwright, ADMIN);
  const res = await ctx.get("/api/account/capabilities");
  expect(res.ok()).toBeTruthy();
  const caps = await res.json();
  expect(typeof caps.twoFactor).toBe("boolean");
  expect(Array.isArray(caps.providers)).toBe(true);
  expect(typeof caps.deleteAccount).toBe("boolean");
  expect(typeof caps.signupApprovalRequired).toBe("boolean");
  await ctx.dispose();
});

test("admin can update a user and impersonate them", async ({ playwright, disposableUsers }) => {
  const admin = await signedIn(playwright, ADMIN);
  const email = `api-edit-${Date.now()}@example.com`;
  const created = await admin.post("/api/auth/admin/create-user", {
    data: { email, password: "Podokit3e-Str0ng!pw", name: "Edit Me", role: "user" },
  });
  const userId = await disposableUsers.trackResponse(created);

  const updated = await admin.post("/api/auth/admin/update-user", { data: { userId, data: { name: "Updated" } } });
  expect(updated.ok()).toBeTruthy();

  // impersonate on a fresh context so shared sessions are untouched
  const imp = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await imp.post("/api/auth/sign-in/email", { data: { email: ADMIN.email, password: ADMIN.password } });
  expect((await imp.post("/api/auth/admin/impersonate-user", { data: { userId } })).ok()).toBeTruthy();
  const session = await (await imp.get("/api/auth/get-session")).json();
  expect(session?.user?.email).toBe(email);
  expect(session?.session?.impersonatedBy).toBeTruthy();
  await imp.post("/api/auth/admin/stop-impersonating");
  await imp.dispose();

  await admin.post("/api/auth/admin/remove-user", { data: { userId } });
  disposableUsers.forget(userId);
  await admin.dispose();
});
