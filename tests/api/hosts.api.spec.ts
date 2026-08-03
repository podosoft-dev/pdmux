import { expect, test } from "@playwright/test";
import { ADMIN, USER } from "../helpers/accounts";

/**
 * Who may register a machine.
 *
 * A personal scope has one member, so requiring an administrator there protected
 * nobody — it meant a plain user could not register their own laptop, and the fleet
 * they were refused write access to was their own and empty. These specs pin the rule
 * from the outside: a member owns their scope, and the scope filter still keeps two
 * people's machines apart.
 */
const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

async function signedIn(
  playwright: import("@playwright/test").PlaywrightWorkerArgs["playwright"],
  account: { email: string; password: string },
): Promise<import("@playwright/test").APIRequestContext> {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const res = await ctx.post("/api/auth/sign-in/email", { data: account });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ctx;
}

test.describe("[TC-PDADMIN-021] a member registers their own machine", () => {
  test("creates, reads back, renames and removes a host in its own scope", async ({ playwright }) => {
    const member = await signedIn(playwright, USER);
    const label = `member-${Date.now()}`;

    const created = await member.post("/api/hosts", { data: { label, tags: [] } });
    expect(created.status(), await created.text()).toBe(201);
    const host = (await created.json()) as { id: string; label: string; enrollment: { code?: string } | null };
    expect(host.label).toBe(label);

    try {
      // The registration response carries the one-shot code, so there is no second
      // admin-only step between "I made a host" and "I can install its agent".
      expect(host.enrollment?.code, "registration should mint an enrollment code").toBeTruthy();

      const listed = await member.get("/api/hosts");
      expect(listed.ok()).toBeTruthy();
      expect(((await listed.json()) as { id: string }[]).map((h) => h.id)).toContain(host.id);

      const renamed = await member.patch(`/api/hosts/${host.id}`, { data: { label: `${label}-renamed` } });
      expect(renamed.ok(), await renamed.text()).toBeTruthy();

      const minted = await member.post(`/api/hosts/${host.id}/tokens`, { data: { name: "laptop" } });
      expect(minted.ok(), await minted.text()).toBeTruthy();
    } finally {
      const removed = await member.delete(`/api/hosts/${host.id}`);
      expect(removed.ok(), await removed.text()).toBeTruthy();
    }
  });

  /**
   * The half that must NOT change. Widening who may write did not widen who may see:
   * a foreign host still answers 404 rather than 403, because 403 confirms the id
   * exists (REQ-PDHOST-002).
   */
  test("cannot see or touch another account's host", async ({ playwright }) => {
    const admin = await signedIn(playwright, ADMIN);
    const member = await signedIn(playwright, USER);
    const label = `admin-only-${Date.now()}`;

    const created = await admin.post("/api/hosts", { data: { label, tags: [] } });
    expect(created.status(), await created.text()).toBe(201);
    const host = (await created.json()) as { id: string };

    try {
      const listed = await member.get("/api/hosts");
      expect(listed.ok()).toBeTruthy();
      expect(((await listed.json()) as { id: string }[]).map((h) => h.id)).not.toContain(host.id);

      expect((await member.get(`/api/hosts/${host.id}`)).status()).toBe(404);
      expect((await member.patch(`/api/hosts/${host.id}`, { data: { label: "stolen" } })).status()).toBe(404);
      expect((await member.post(`/api/hosts/${host.id}/tokens`, { data: { name: "x" } })).status()).toBe(404);
      expect((await member.delete(`/api/hosts/${host.id}`)).status()).toBe(404);

      // The failed attempts left the original untouched.
      const still = await admin.get(`/api/hosts/${host.id}`);
      expect(still.ok()).toBeTruthy();
    } finally {
      await admin.delete(`/api/hosts/${host.id}`);
    }
  });

  test("reports the scope it is looking at", async ({ playwright }) => {
    const member = await signedIn(playwright, USER);
    const res = await member.get("/api/fleet/scope");
    expect(res.ok(), await res.text()).toBeTruthy();
    expect(await res.json()).toEqual({ personal: true, canManage: true });
  });
});
