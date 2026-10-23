import { expect, test, type APIRequestContext } from "@playwright/test";
import { ADMIN, USER } from "../helpers/accounts";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

async function signedIn(
  playwright: { request: { newContext: (options: object) => Promise<APIRequestContext> } },
  account: { email: string; password: string },
): Promise<APIRequestContext> {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const res = await ctx.post("/api/auth/sign-in/email", { data: { email: account.email, password: account.password } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ctx;
}

async function setTeams(admin: APIRequestContext, on: boolean): Promise<void> {
  const res = await admin.put("/api/account/settings", { data: { teams: on } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

// Toggles the server-wide teams setting, so it runs alone.
test("organization teams: create, rename, members, and the setting gate", { tag: "@exclusive" }, async ({ playwright }) => {
  test.slow();
  const admin = await signedIn(playwright, ADMIN);
  const caps = await (await admin.get("/api/account/capabilities")).json();
  test.skip(!caps?.organization, "organizations not enabled");

  const user = await signedIn(playwright, USER);
  const userId = (await (await user.get("/api/auth/get-session")).json()).user.id as string;

  const stamp = Date.now();
  const created = await admin.post("/api/auth/organization/create", {
    data: { name: `Teams ${stamp}`, slug: `teams-${stamp}` },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const organizationId = (await created.json()).id as string;
  const teamsStatus = (): Promise<number> =>
    admin.get(`/api/auth/organization/list-teams?organizationId=${organizationId}`).then((r) => r.status());

  try {
    const added = await admin.post("/api/account/org-member", { data: { organizationId, userId, role: "member" } });
    expect(added.ok(), await added.text()).toBeTruthy();

    await setTeams(admin, true);
    await expect.poll(teamsStatus, { timeout: 8000 }).toBe(200);
    expect((await (await admin.get("/api/account/capabilities")).json()).teams).toBe(true);
    // Organizations start without a team.
    expect(await (await admin.get(`/api/auth/organization/list-teams?organizationId=${organizationId}`)).json()).toEqual([]);

    const team = await admin.post("/api/auth/organization/create-team", { data: { name: "Platform", organizationId } });
    expect(team.ok(), await team.text()).toBeTruthy();
    const teamId = (await team.json()).id as string;

    const renamed = await admin.post("/api/auth/organization/update-team", {
      data: { teamId, data: { name: "Platform core", organizationId } },
    });
    expect(renamed.ok(), await renamed.text()).toBeTruthy();
    const listed = (await (await admin.get(`/api/auth/organization/list-teams?organizationId=${organizationId}`)).json()) as Array<{ id: string; name: string }>;
    expect(listed.map((t) => [t.id, t.name])).toEqual([[teamId, "Platform core"]]);

    const membersUrl = `/api/account/team-members?organizationId=${organizationId}&teamId=${teamId}`;
    const joined = await admin.post("/api/auth/organization/add-team-member", { data: { teamId, userId, organizationId } });
    expect(joined.ok(), await joined.text()).toBeTruthy();
    const members = (await (await admin.get(membersUrl)).json()) as Array<{ userId: string; email: string }>;
    expect(members.map((m) => [m.userId, m.email])).toEqual([[userId, USER.email]]);
    // Any organization member can see a team's members, including the member listed.
    expect((await user.get(membersUrl)).status()).toBe(200);

    const left = await admin.post("/api/auth/organization/remove-team-member", { data: { teamId, userId, organizationId } });
    expect(left.ok(), await left.text()).toBeTruthy();
    expect(await (await admin.get(membersUrl)).json()).toEqual([]);

    // Switched off, team endpoints and the members listing answer 404 while the
    // rest of organizations keeps working.
    await setTeams(admin, false);
    await expect.poll(teamsStatus, { timeout: 8000 }).toBe(404);
    expect((await admin.post("/api/auth/organization/create-team", { data: { name: "Off", organizationId } })).status()).toBe(404);
    expect((await admin.get(membersUrl)).status()).toBe(404);
    expect((await (await admin.get("/api/account/capabilities")).json()).teams).toBe(false);
    expect((await admin.get(`/api/auth/organization/get-full-organization?organizationId=${organizationId}`)).status()).toBe(200);

    await setTeams(admin, true);
    await expect.poll(teamsStatus, { timeout: 8000 }).toBe(200);
    const removed = await admin.post("/api/auth/organization/remove-team", { data: { teamId, organizationId } });
    expect(removed.ok(), await removed.text()).toBeTruthy();
    expect(await (await admin.get(`/api/auth/organization/list-teams?organizationId=${organizationId}`)).json()).toEqual([]);
  } finally {
    await setTeams(admin, false);
    await admin.post("/api/auth/organization/delete", { data: { organizationId } });
    await user.dispose();
    await admin.dispose();
  }
});
