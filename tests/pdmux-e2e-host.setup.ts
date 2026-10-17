import { expect, test as setup } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { E2E_ADMIN, e2eAdminState, e2eAgentToken } from "./helpers/pdmux-accounts";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
/** The label the e2e host is registered under, so repeated runs reuse it. */
const E2E_HOST_LABEL = "pdmux-e2e-host";
/** Offline filler cards make the sidebar overflow contract observable. */
const FILLER_HOSTS = 11;
/** The checkout the git specs read. A runner elsewhere can point at its own checkout. */
const E2E_GIT_ROOT = process.env.E2E_GIT_ROOT ?? process.cwd().replace(/\/tests$/, "");

/**
 * Seed an account, host and token used only by the pdmux product specs.
 *
 * Fleet rows are account-scoped, so the isolated account must own the live host used by
 * terminal, git and MCP tests. The token is written once for the local agent process that
 * the e2e runner starts after setup. The session is pinned to English like the seeded
 * accounts' in seed.setup.ts, because UI locators use the English catalog.
 */
setup("seed pdmux e2e host", async ({ playwright }) => {
  mkdirSync(dirname(e2eAdminState), { recursive: true });
  const session = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  await session.post("/api/auth/sign-up/email", { data: E2E_ADMIN }).catch(() => undefined); // idempotent
  const signIn = await session.post("/api/auth/sign-in/email", {
    data: { email: E2E_ADMIN.email, password: E2E_ADMIN.password },
  });
  expect(signIn.ok(), `sign-in ${E2E_ADMIN.email}`).toBeTruthy();
  expect((await session.post("/api/auth/revoke-other-sessions")).ok(), "clear old e2e sessions").toBeTruthy();
  const state = await session.storageState();
  const url = new URL(base);
  writeFileSync(e2eAdminState, `${JSON.stringify({
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
        sameSite: "Lax" as const,
      },
    ],
  }, null, 2)}\n`);
  await session.dispose();

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
