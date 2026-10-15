import type { APIRequestContext, PlaywrightWorkerArgs } from "@playwright/test";
import { expect, test } from "../helpers/disposable-users";
import { ADMIN, USER } from "../helpers/accounts";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };
const PASSWORD = "Podokit3e-Str0ng!pw";
// The rate-limit module's default ceiling for /api/auth/* per window. Listing
// sessions through Better Auth took 1 + one request per user from that budget;
// the sessions endpoint takes one general request per page.
const DEFAULT_AUTH_RATE_LIMIT = 20;

type SessionItem = {
  id: string;
  userId: string;
  userEmail: string;
  createdAt: string;
  [key: string]: unknown;
};
type SessionPage = { items: SessionItem[]; nextCursor: string | null; total: number };

async function signedIn(
  playwright: PlaywrightWorkerArgs["playwright"],
  account: { email: string; password: string },
): Promise<APIRequestContext> {
  const context = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  expect((await context.post("/api/auth/sign-in/email", { data: account })).ok()).toBeTruthy();
  return context;
}

test("admin pages through every user's session with a few requests outside the auth budget", async ({
  playwright,
  disposableUsers,
}) => {
  test.setTimeout(180_000);
  const prefix = `sess-page-${Date.now()}`;
  const userCount = 27;
  const pageSize = 10;
  const userIds = new Set<string>();
  const signIns = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  for (let index = 0; index < userCount; index += 1) {
    const email = `${prefix}-${String(index).padStart(2, "0")}@example.com`;
    userIds.add(await disposableUsers.create({ email, name: `Session pager ${index}` }));
    expect((await signIns.post("/api/auth/sign-in/email", { data: { email, password: PASSWORD } })).ok())
      .toBeTruthy();
  }
  await signIns.dispose();

  const admin = await signedIn(playwright, ADMIN);
  const seen: SessionItem[] = [];
  let requests = 0;
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: String(pageSize), search: prefix });
    if (cursor) query.set("cursor", cursor);
    const response = await admin.get(`/api/admin/sessions?${query.toString()}`);
    requests += 1;
    expect(response.status()).toBe(200);
    const remaining = response.headers()["ratelimit-remaining"];
    if (remaining !== undefined) expect(Number(remaining)).toBeGreaterThan(0);
    const page = (await response.json()) as SessionPage;
    expect(page.total).toBe(userCount);
    for (const item of page.items) expect(item).not.toHaveProperty("token");
    seen.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && requests <= userCount);

  expect(requests).toBe(Math.ceil(userCount / pageSize));
  expect(requests).toBeLessThan(DEFAULT_AUTH_RATE_LIMIT);
  expect(new Set(seen.map((item) => item.id)).size).toBe(userCount);
  expect(new Set(seen.map((item) => item.userId))).toEqual(userIds);
  const created = seen.map((item) => Date.parse(item.createdAt));
  expect(created).toEqual([...created].sort((left, right) => right - left));
  await admin.dispose();
});

test("a normal user cannot list or revoke sessions", async ({ playwright }) => {
  const user = await signedIn(playwright, USER);
  expect((await user.get("/api/admin/sessions")).status()).toBe(403);
  expect((await user.delete("/api/admin/sessions/any-session")).status()).toBe(403);
  await user.dispose();
});

test("admin revokes a session by id and the action is audited", async ({ playwright, disposableUsers }) => {
  const email = `sess-revoke-${Date.now()}@example.com`;
  const userId = await disposableUsers.create({ email, name: "Revoke by id" });
  const theirs = await signedIn(playwright, { email, password: PASSWORD });
  const admin = await signedIn(playwright, ADMIN);

  const listed = await admin.get(`/api/admin/sessions?userId=${encodeURIComponent(userId)}`);
  expect(listed.ok()).toBeTruthy();
  const page = (await listed.json()) as SessionPage;
  expect(page.items).toHaveLength(1);
  const sessionId = page.items[0]?.id ?? "";

  const revoked = await admin.delete(`/api/admin/sessions/${encodeURIComponent(sessionId)}`);
  expect(revoked.status()).toBe(204);
  expect(await (await theirs.get("/api/auth/get-session")).json()).toBeNull();
  expect((await admin.delete(`/api/admin/sessions/${encodeURIComponent(sessionId)}`)).status()).toBe(404);

  // The revoke runs through Better Auth, so the audit-log module records it when
  // the module is installed and auditing is on.
  const capabilities = (await (await admin.get("/api/account/capabilities")).json()) as { auditLog?: boolean };
  const audit = await admin.get("/api/audit-logs");
  if (capabilities.auditLog === true && audit.ok()) {
    const body = (await audit.json()) as unknown;
    const entries = (Array.isArray(body) ? body : (body as { items?: unknown[] }).items ?? []) as Array<{
      action?: string;
      actorEmail?: string | null;
    }>;
    expect(entries.some((entry) => entry.action === "user.session_revoke" && entry.actorEmail === ADMIN.email))
      .toBeTruthy();
  }
  await theirs.dispose();
  await admin.dispose();
});

test("a forged cursor is rejected", async ({ playwright }) => {
  const admin = await signedIn(playwright, ADMIN);
  const response = await admin.get("/api/admin/sessions?cursor=forged");
  expect(response.status()).toBe(400);
  expect((await response.json())?.error?.code).toBe("ADMIN_SESSION_CURSOR_INVALID");
  await admin.dispose();
});
