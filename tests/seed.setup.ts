import { test as setup, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ADMIN,
  USER,
  adminState,
  userState,
  userBaselineState,
  type Account,
} from "./helpers/accounts";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
mkdirSync(dirname(adminState), { recursive: true });

type StorageState = Awaited<
  ReturnType<import("@playwright/test").APIRequestContext["storageState"]>
>;

function withTestLocale(state: StorageState): StorageState {
  const url = new URL(base);
  return {
    ...state,
    cookies: [
      ...state.cookies.filter((cookie) => cookie.name !== "locale"),
      {
        name: "locale",
        value: "en",
        domain: url.hostname,
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: url.protocol === "https:",
        sameSite: "Lax",
      },
    ],
  };
}

// Seed a session via the API (reliable, no UI hydration races) and save its
// cookies as storageState for the browser `ui` project to reuse. Pin the suite
// locale because UI locators use the generated English catalog and must not
// inherit an application's configured default language.
//
// The user signs up here. The administrator cannot: the API refuses a sign-up
// with an ADMIN_EMAILS address that has not proven it, so the account comes
// from admin:bootstrap before the suite runs.
async function seedSession(
  playwright: import("@playwright/test").PlaywrightWorkerArgs["playwright"],
  account: Account,
  path: string,
  { signUp }: { signUp: boolean },
): Promise<void> {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  if (signUp) await ctx.post("/api/auth/sign-up/email", { data: account }).catch(() => undefined); // idempotent
  const res = await ctx.post("/api/auth/sign-in/email", {
    data: { email: account.email, password: account.password },
  });
  expect(
    res.ok(),
    signUp
      ? `sign-in ${account.email}`
      : `sign-in ${account.email}: create the administrator first with ` +
          `ADMIN_BOOTSTRAP_EMAIL=${account.email} ADMIN_BOOTSTRAP_PASSWORD=<its password> ADMIN_BOOTSTRAP_NAME="${account.name}" bun run --cwd apps/api admin:bootstrap, ` +
          "or name an existing administrator as tests/helpers/accounts.ts describes",
  ).toBeTruthy();
  // Each run signs in again, so keep a long-lived local database from piling up
  // this account's sessions: the seeded one is the only one left.
  expect((await ctx.post("/api/auth/revoke-other-sessions")).ok(), `clear old sessions for ${account.email}`).toBeTruthy();
  writeFileSync(path, `${JSON.stringify(withTestLocale(await ctx.storageState()), null, 2)}\n`);
  await ctx.dispose();
}

setup("seed admin session", async ({ playwright }) => {
  await seedSession(playwright, ADMIN, adminState, { signUp: false });
});

// Feature flags are DB-backed (seeded by the app_setting migration). phoneNumber
// ships off (needs an SMS provider); turn it on here so its specs run — this also
// exercises the admin settings API on every suite run.
setup("enable optional features", async ({ playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  await ctx.post("/api/auth/sign-in/email", { data: { email: ADMIN.email, password: ADMIN.password } });
  const res = await ctx.put("/api/account/settings", { data: { phoneNumber: true } });
  expect(res.ok(), "enable optional features via settings").toBeTruthy();
  await ctx.dispose();
});

setup("seed user session", async ({ playwright }) => {
  await seedSession(playwright, USER, userState, { signUp: true });
});

setup("capture the user cleanup baseline", async ({ playwright }) => {
  const ctx = await playwright.request.newContext({
    baseURL: base,
    extraHTTPHeaders: { origin: base },
  });
  try {
    const signIn = await ctx.post("/api/auth/sign-in/email", {
      data: { email: ADMIN.email, password: ADMIN.password },
    });
    expect(signIn.ok(), "sign in before capturing the user baseline").toBeTruthy();
    const ids: string[] = [];
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const response = await ctx.get(`/api/auth/admin/list-users?limit=${limit}&offset=${offset}`);
      expect(response.ok(), "list users before the suite").toBeTruthy();
      const body = (await response.json()) as { users?: Array<{ id?: unknown }> };
      const page = body.users ?? [];
      ids.push(
        ...page
          .map((user) => user.id)
          .filter((id): id is string => typeof id === "string"),
      );
      if (page.length < limit) break;
    }
    writeFileSync(userBaselineState, `${JSON.stringify(ids, null, 2)}\n`);
  } finally {
    await ctx.dispose();
  }
});
