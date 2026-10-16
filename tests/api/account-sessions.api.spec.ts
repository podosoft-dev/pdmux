import { signInOnSeparateDevices } from "../helpers/devices";
import { expect, test } from "../helpers/disposable-users";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

type Page = {
  current: { id: string } | null;
  items: Array<{ id: string }>;
  nextCursor: string | null;
  total: number;
};

test("account sessions page the user's own sessions and revoke one by id", async ({ playwright, disposableUsers }) => {
  const email = `api-account-sessions-${Date.now()}@example.com`;
  const password = "Podokit3e-Str0ng!pw";
  await disposableUsers.create({ email, password, name: "Account sessions" });
  expect(await signInOnSeparateDevices(email, password, 4)).toEqual([200, 200, 200, 200]);
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  expect((await ctx.post("/api/auth/sign-in/email", { data: { email, password } })).ok()).toBeTruthy();
  const current = (await (await ctx.get("/api/auth/get-session")).json()) as { session: { id: string } };

  const first = await ctx.get("/api/account/sessions?limit=2");
  expect(first.ok()).toBeTruthy();
  const firstText = await first.text();
  expect(firstText).not.toContain("token");
  const page1 = JSON.parse(firstText) as Page;
  expect(page1.current?.id).toBe(current.session.id);
  expect(page1.total).toBe(5);
  expect(page1.items).toHaveLength(2);
  expect(page1.nextCursor).toBeTruthy();
  const page2 = (await (await ctx.get(`/api/account/sessions?limit=2&cursor=${encodeURIComponent(page1.nextCursor ?? "")}`)).json()) as Page;
  expect(page2.current?.id).toBe(current.session.id);
  expect(page2.nextCursor).toBeNull();
  const ids = [...page1.items, ...page2.items].map((item) => item.id);
  expect(new Set(ids).size).toBe(4);
  expect(ids).not.toContain(current.session.id);

  // Another user's session cannot be revoked through this endpoint.
  const otherEmail = `api-account-sessions-other-${Date.now()}@example.com`;
  await disposableUsers.create({ email: otherEmail, password, name: "Other user" });
  const otherUser = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  expect((await otherUser.post("/api/auth/sign-in/email", { data: { email: otherEmail, password } })).ok()).toBeTruthy();
  const otherSession = (await (await otherUser.get("/api/auth/get-session")).json()) as { session: { id: string } };
  const foreign = await ctx.delete(`/api/account/sessions/${encodeURIComponent(otherSession.session.id)}`);
  expect(foreign.status()).toBe(404);
  expect(await foreign.json()).toMatchObject({ error: { code: "ACCOUNT_SESSION_NOT_FOUND" } });
  expect((await otherUser.get("/api/auth/get-session")).ok()).toBeTruthy();
  await otherUser.dispose();

  const revoked = await ctx.delete(`/api/account/sessions/${encodeURIComponent(ids[0] ?? "")}`);
  expect(revoked.status()).toBe(204);
  expect(((await (await ctx.get("/api/account/sessions?limit=2")).json()) as Page).total).toBe(4);
  await ctx.dispose();
});
