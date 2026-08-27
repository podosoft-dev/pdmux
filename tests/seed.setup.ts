import { test as setup, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ADMIN,
  E2E_ADMIN,
  USER,
  adminState,
  e2eAdminState,
  e2eAgentToken,
  userState,
  userBaselineState,
  type Account,
} from "./helpers/accounts";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
mkdirSync(dirname(adminState), { recursive: true });

/** The label the e2e host is registered under, so repeated runs reuse it. */
const E2E_HOST_LABEL = "pdmux-e2e-host";
/** Offline filler cards make the sidebar overflow contract observable. */
const FILLER_HOSTS = 11;
/** The checkout the git specs read. A runner elsewhere can point at its own checkout. */
const E2E_GIT_ROOT = process.env.E2E_GIT_ROOT ?? process.cwd().replace(/\/tests$/, "");

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
async function seedSession(
  playwright: import("@playwright/test").PlaywrightWorkerArgs["playwright"],
  account: Account,
  path: string,
): Promise<void> {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  await ctx.post("/api/auth/sign-up/email", { data: account }).catch(() => undefined); // idempotent
  const res = await ctx.post("/api/auth/sign-in/email", {
    data: { email: account.email, password: account.password },
  });
  expect(res.ok(), `sign-in ${account.email}`).toBeTruthy();
  // Keep repeated local runs from filling better-auth's 100-session response
  // before the newly created current session can appear in account tests. The
  // endpoint clears at most one response page, so drain several pages when a
  // long-lived local database has accumulated them.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const sessionsResponse = await ctx.get("/api/auth/list-sessions");
    const sessions = sessionsResponse.ok() ? (await sessionsResponse.json()) as unknown : [];
    if (!Array.isArray(sessions) || sessions.length <= 1) break;
    expect((await ctx.post("/api/auth/revoke-other-sessions")).ok(), `clear old sessions for ${account.email}`).toBeTruthy();
  }
  writeFileSync(path, `${JSON.stringify(withTestLocale(await ctx.storageState()), null, 2)}\n`);
  await ctx.dispose();
}

setup("seed admin session", async ({ playwright }) => {
  await seedSession(playwright, ADMIN, adminState);
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
  await seedSession(playwright, USER, userState);
});

/**
 * Seed an account, host and token used only by the pdmux product specs.
 *
 * Fleet rows are account-scoped, so the isolated account must own the live host used by
 * terminal, git and MCP tests. The token is written once for the local agent process that
 * the e2e runner starts after setup.
 */
setup("seed pdmux e2e host", async ({ playwright }) => {
  await seedSession(playwright, E2E_ADMIN, e2eAdminState);
  const ctx = await playwright.request.newContext({
    baseURL: base,
    extraHTTPHeaders: { origin: base },
    storageState: e2eAdminState,
  });
  const existing = (await (await ctx.get("/api/hosts")).json()) as { id: string; label: string }[];
  const host =
    existing.find((entry) => entry.label === E2E_HOST_LABEL) ??
    ((await (
      await ctx.post("/api/hosts", { data: { label: E2E_HOST_LABEL, address: "127.0.0.1" } })
    ).json()) as { id: string });
  expect(host?.id, "register the e2e host").toBeTruthy();

  const minted = (await (
    await ctx.post(`/api/hosts/${host.id}/tokens`, { data: { name: "e2e" } })
  ).json()) as { token?: string };
  if (minted.token) {
    await writeFile(e2eAgentToken, minted.token, { encoding: "utf8", mode: 0o600 });
    await chmod(e2eAgentToken, 0o600);
  }

  await ctx.put("/api/fleet/settings", { data: { gitRoots: [E2E_GIT_ROOT], gitIntervalSec: 30 } });

  const labels = new Set(existing.map((entry) => entry.label));
  for (let index = 0; index < FILLER_HOSTS; index += 1) {
    const label = `${E2E_HOST_LABEL}-filler-${index}`;
    if (labels.has(label)) continue;
    await ctx.post("/api/hosts", { data: { label, address: "127.0.0.1" } });
  }
  await ctx.dispose();
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
