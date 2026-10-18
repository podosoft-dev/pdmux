import { expect, test as setup } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ADMIN } from "./helpers/accounts";
import { E2E_OWNER, e2eAgentToken, e2eOwnerState, withEnglishLocale } from "./helpers/pdmux-accounts";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
/** The label the e2e host is registered under, so repeated runs reuse it. */
const E2E_HOST_LABEL = "pdmux-e2e-host";
/** Offline filler cards make the sidebar overflow contract observable. */
const FILLER_HOSTS = 11;
/** The checkout the git specs read. A runner elsewhere can point at its own checkout. */
const E2E_GIT_ROOT = process.env.E2E_GIT_ROOT ?? process.cwd().replace(/\/tests$/, "");

/**
 * Seed the organization, host and token the pdmux product specs share.
 *
 * Fleet rows are scoped per organization, so an organization owned by `E2E_OWNER` holds
 * the live host used by terminal, git and MCP tests, and every worker account the specs
 * sign in as (`helpers/pdmux-test.ts`) joins it. The token is written once for the local
 * agent process that the e2e runner starts after setup.
 */
setup("seed pdmux e2e host", async ({ playwright }) => {
  mkdirSync(dirname(e2eOwnerState), { recursive: true });
  const session = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  const ownerSignIn = () =>
    session.post("/api/auth/sign-in/email", { data: { email: E2E_OWNER.email, password: E2E_OWNER.password } });
  let signIn = await ownerSignIn();
  if (!signIn.ok()) {
    // An ADMIN_EMAILS address may not sign up, so the seeded administrator creates the
    // owner as an administrator. `e2e:reset` removes it, so this runs after each reset.
    const admin = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
    const adminSignIn = await admin.post("/api/auth/sign-in/email", { data: { email: ADMIN.email, password: ADMIN.password } });
    expect(adminSignIn.ok(), `sign-in ${ADMIN.email} to create ${E2E_OWNER.email}`).toBeTruthy();
    const created = await admin.post("/api/auth/admin/create-user", { data: { ...E2E_OWNER, role: "admin" } });
    expect(created.ok(), `create ${E2E_OWNER.email}: ${await created.text()}`).toBeTruthy();
    await admin.dispose();
    signIn = await ownerSignIn();
  }
  expect(signIn.ok(), `sign-in ${E2E_OWNER.email}`).toBeTruthy();
  expect((await session.post("/api/auth/revoke-other-sessions")).ok(), "clear old e2e sessions").toBeTruthy();

  // The slug carries the owner's id: slugs are unique across the stack, and an owner the
  // suite's cleanup removed leaves its organization behind without a member to find it by.
  const owner = (await (await session.get("/api/auth/get-session")).json()) as { user: { id: string } };
  const slug = `pdmux-e2e-${owner.user.id.toLowerCase()}`;
  const organizations = await session.get("/api/auth/organization/list");
  expect(organizations.ok(), `list organizations: ${await organizations.text()}`).toBeTruthy();
  let organization = ((await organizations.json()) as { id: string; slug: string }[]).find((row) => row.slug === slug);
  if (!organization) {
    const created = await session.post("/api/auth/organization/create", { data: { name: "pdmux e2e", slug } });
    expect(created.ok(), `create the e2e organization: ${await created.text()}`).toBeTruthy();
    organization = (await created.json()) as { id: string; slug: string };
  }
  const active = await session.post("/api/auth/organization/set-active", { data: { organizationId: organization.id } });
  expect(active.ok(), `act in the e2e organization: ${await active.text()}`).toBeTruthy();
  expect(
    await (await session.get("/api/fleet/scope")).json(),
    `${E2E_OWNER.email} manages the organization's fleet: it must be an administrator`,
  ).toEqual({ personal: false, canManage: true });

  writeFileSync(e2eOwnerState, `${JSON.stringify(withEnglishLocale(await session.storageState(), base), null, 2)}\n`);
  await session.dispose();

  const ctx = await playwright.request.newContext({
    baseURL: base,
    extraHTTPHeaders: { origin: base },
    storageState: e2eOwnerState,
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
