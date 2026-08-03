import { expect, test as setup } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { E2E_ADMIN } from "./helpers/accounts";
import { LAYOUT_SNAPSHOT } from "./helpers/layout-snapshot";

/**
 * Save the dashboard layout of the account the pdmux specs sign in as.
 *
 * WHY: the pdmux specs write that layout on purpose — split mode, which cell holds which
 * session, whether the git dock is open — because that is the behaviour under test. But the
 * account is also somebody's: the specs now have an account of their own
 * (`E2E_ADMIN`), so this is a second line of defence rather than the only one: a run that
 * dies half way still leaves that account's layout as it found it.
 *
 * ⚠ It signs in itself rather than reading the seeded `storageState`. Setup tests are
 * ordered by FILE NAME, and this file sorts before `seed.setup.ts` — reading the state file
 * meant reading a session that did not exist yet, which failed the whole run at its first
 * step (127 tests "did not run").
 *
 * `null` is a real value: the account may have no saved layout at all, and restoring must
 * then DELETE the row rather than leave whatever the suite created.
 */
setup("snapshot the dashboard layout", async ({ playwright }) => {
  const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  const signIn = await ctx.post("/api/auth/sign-in/email", {
    data: { email: E2E_ADMIN.email, password: E2E_ADMIN.password },
  });
  // A fresh database has not been seeded yet; there is then nothing to protect.
  if (!signIn.ok()) {
    await writeFile(LAYOUT_SNAPSHOT, "null", "utf8").catch(() => undefined);
    await ctx.dispose();
    return;
  }
  const response = await ctx.get("/api/prefs");
  expect(response.ok(), "read prefs to snapshot the layout").toBeTruthy();
  const prefs = (await response.json()) as {
    layouts?: { name: string; payload: Record<string, unknown>; isDefault?: boolean }[];
  };
  const layout = prefs.layouts?.find((entry) => entry.isDefault) ?? prefs.layouts?.[0] ?? null;
  await mkdir(dirname(LAYOUT_SNAPSHOT), { recursive: true });
  await writeFile(LAYOUT_SNAPSHOT, JSON.stringify(layout), "utf8");
  await ctx.dispose();
});
