import type { APIRequestContext, PlaywrightWorkerArgs } from "@playwright/test";
import { expect, test } from "../helpers/disposable-users";
import { ADMIN, USER } from "../helpers/accounts";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

type UserItem = {
  id: string;
  email: string;
  role: string | null;
  banned: boolean;
  signupApproved: boolean;
  [key: string]: unknown;
};
type UserPage = { items: UserItem[]; total: number };

async function signedIn(
  playwright: PlaywrightWorkerArgs["playwright"],
  account: { email: string; password: string },
): Promise<APIRequestContext> {
  const context = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  expect((await context.post("/api/auth/sign-in/email", { data: account })).ok()).toBeTruthy();
  return context;
}

async function list(admin: APIRequestContext, query: Record<string, string>): Promise<UserPage> {
  const response = await admin.get(`/api/admin/users?${new URLSearchParams(query).toString()}`);
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as UserPage;
}

test("the admin user list combines role and status filters with a search", async ({
  playwright,
  disposableUsers,
}) => {
  const prefix = `users-filter-${Date.now()}`;
  const ids = {
    activeAdmin: await disposableUsers.create({ email: `${prefix}-a@example.com`, role: "admin" }),
    bannedAdmin: await disposableUsers.create({ email: `${prefix}-b@example.com`, role: "admin" }),
    activeUser: await disposableUsers.create({ email: `${prefix}-c@example.com` }),
    pendingUser: await disposableUsers.create({ email: `${prefix}-d@example.com` }),
  };
  const admin = await signedIn(playwright, ADMIN);
  try {
    expect((await admin.post("/api/auth/admin/ban-user", { data: { userId: ids.bannedAdmin } })).ok())
      .toBeTruthy();
    expect((await admin.post("/api/auth/admin/update-user", {
      data: { userId: ids.pendingUser, data: { signupApproved: false } },
    })).ok()).toBeTruthy();

    const matching = async (role: string, status: string): Promise<string[]> =>
      (await list(admin, { search: prefix.toUpperCase(), role, status })).items.map((user) => user.id);
    expect(await matching("admin", "active")).toEqual([ids.activeAdmin]);
    expect(await matching("admin", "banned")).toEqual([ids.bannedAdmin]);
    expect(await matching("user", "pending")).toEqual([ids.pendingUser]);
    expect(await matching("user", "active")).toEqual([ids.activeUser]);

    const all = await list(admin, { search: prefix, limit: "2", sortBy: "email", sortDirection: "asc" });
    expect(all.total).toBe(4);
    expect(all.items.map((user) => user.id)).toEqual([ids.activeAdmin, ids.bannedAdmin]);
    const banned = all.items[1];
    expect(banned?.banned).toBe(true);
    expect(banned?.signupApproved).toBe(true);
    expect(banned).not.toHaveProperty("password");
  } finally {
    await admin.dispose();
  }
});

test("the admin user list is for administrators and validates its query", async ({ playwright }) => {
  const anonymous = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const user = await signedIn(playwright, USER);
  const admin = await signedIn(playwright, ADMIN);
  try {
    expect((await anonymous.get("/api/admin/users")).status()).toBe(401);
    expect((await user.get("/api/admin/users")).status()).toBe(403);
    for (const query of ["status=deleted", "sortBy=password", "limit=101"]) {
      expect((await admin.get(`/api/admin/users?${query}`)).status(), query).toBe(400);
    }
  } finally {
    await anonymous.dispose();
    await user.dispose();
    await admin.dispose();
  }
});
