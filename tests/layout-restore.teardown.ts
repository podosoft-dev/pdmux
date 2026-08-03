import { test as teardown } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { E2E_ADMIN } from "./helpers/accounts";
import { LAYOUT_SNAPSHOT } from "./helpers/layout-snapshot";

/**
 * Put the account's dashboard layout back, whatever the suite did to it.
 *
 * Runs as the `setup` project's teardown, so Playwright executes it once every dependent
 * project has finished — including after failures. The specs still restore what they change
 * (a green run should not need this); this exists because a run that dies half way used to
 * leave somebody's screen rearranged.
 *
 * Signs in itself for the same reason the snapshot does: no dependency on a state file.
 */
teardown("restore the dashboard layout", async ({ playwright }) => {
  const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
  let saved: { name: string; payload: Record<string, unknown>; isDefault?: boolean } | null = null;
  try {
    saved = JSON.parse(await readFile(LAYOUT_SNAPSHOT, "utf8")) as typeof saved;
  } catch {
    // No snapshot (the setup project did not run): leave the row alone rather than guess.
    return;
  }

  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  const signIn = await ctx.post("/api/auth/sign-in/email", {
    data: { email: E2E_ADMIN.email, password: E2E_ADMIN.password },
  });
  if (!signIn.ok()) {
    await ctx.dispose();
    return;
  }
  if (saved) {
    await ctx.put(`/api/prefs/layouts/${encodeURIComponent(saved.name)}`, {
      data: { payload: saved.payload, isDefault: saved.isDefault ?? true },
    });
  } else {
    // The account had NO layout before the suite ran, so "restore" means delete the one the
    // suite created — otherwise the next login opens on the tests' arrangement.
    await ctx.delete("/api/prefs/layouts/default");
  }
  await ctx.dispose();
});
