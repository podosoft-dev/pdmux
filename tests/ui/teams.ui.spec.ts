import { expect, test, type Page } from "@playwright/test";
import { USER } from "../helpers/accounts";
import { ready } from "../helpers/hydration";

async function setTeams(page: Page, baseURL: string | undefined, on: boolean): Promise<void> {
  const res = await page.request.put("/api/account/settings", { data: { teams: on }, headers: { origin: baseURL ?? "" } });
  expect(res.ok(), await res.text()).toBeTruthy();
  await expect
    .poll(async () => (await (await page.request.get("/api/account/capabilities")).json()).teams, { timeout: 8000 })
    .toBe(on);
}

async function setFlags(page: Page, baseURL: string | undefined, flags: { organization?: boolean; teams?: boolean }): Promise<void> {
  const res = await page.request.put("/api/account/settings", { data: flags, headers: { origin: baseURL ?? "" } });
  expect(res.ok(), await res.text()).toBeTruthy();
  await expect
    .poll(async () => {
      const caps = await (await page.request.get("/api/account/capabilities")).json();
      return (flags.organization === undefined || caps.organization === flags.organization)
        && (flags.teams === undefined || caps.teams === (flags.teams && caps.organization));
    }, { timeout: 8000 })
    .toBe(true);
}

// Toggles the server-wide organization and teams settings.
test("settings: the Teams switch waits for Organizations and gates the Teams action", { tag: "@exclusive" }, async ({ page, baseURL }) => {
  test.slow();
  const headers = { origin: baseURL ?? "" };
  const initial = await (await page.request.get("/api/account/capabilities")).json();
  test.skip(initial?.organization === undefined, "organizations not installed");

  const stamp = Date.now();
  const orgName = `Teams switch ${stamp}`;
  let organizationId: string | undefined;
  const teamsSwitch = page.getByRole("switch", { name: "Teams", exact: true });
  const openAuthentication = async (): Promise<void> => {
    await ready(page, "/admin/settings");
    await page.getByRole("tab", { name: "Authentication" }).click();
  };

  // The settings page is application-owned: an app updated from a version
  // without teams keeps its own page until it adds the switch.
  await openAuthentication();
  test.skip((await teamsSwitch.count()) === 0, "the settings page does not render the Teams switch");

  try {
    // Organizations off: the Teams switch is locked.
    await setFlags(page, baseURL, { organization: false, teams: false });
    await openAuthentication();
    await expect(teamsSwitch).toBeDisabled();
    await expect(teamsSwitch).not.toBeChecked();

    await setFlags(page, baseURL, { organization: true });
    const created = await page.request.post("/api/auth/organization/create", {
      data: { name: orgName, slug: `teams-switch-${stamp}` },
      headers,
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    organizationId = (await created.json()).id as string;
    const listTeams = (): Promise<number> =>
      page.request.get(`/api/auth/organization/list-teams?organizationId=${organizationId}`).then((r) => r.status());

    // Turn Teams on from the switch.
    await openAuthentication();
    await expect(teamsSwitch).toBeEnabled();
    await expect(teamsSwitch).not.toBeChecked();
    await teamsSwitch.click();
    await expect(page.getByText("Setting updated").first()).toBeVisible();
    await expect(teamsSwitch).toBeChecked();
    await expect
      .poll(async () => (await (await page.request.get("/api/account/capabilities")).json()).teams, { timeout: 8000 })
      .toBe(true);
    await expect.poll(listTeams, { timeout: 8000 }).toBe(200);
    await ready(page, "/admin/organizations");
    await expect(page.getByRole("row", { name: new RegExp(orgName) }).getByRole("button", { name: "Teams", exact: true })).toBeVisible();

    // And off again.
    await openAuthentication();
    await expect(teamsSwitch).toBeChecked();
    await teamsSwitch.click();
    await expect(teamsSwitch).not.toBeChecked();
    await expect
      .poll(async () => (await (await page.request.get("/api/account/capabilities")).json()).teams, { timeout: 8000 })
      .toBe(false);
    await expect.poll(listTeams, { timeout: 8000 }).toBe(404);
    await ready(page, "/admin/organizations");
    const row = page.getByRole("row", { name: new RegExp(orgName) });
    await expect(row.getByRole("button", { name: "Manage" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Teams", exact: true })).toHaveCount(0);
  } finally {
    await setFlags(page, baseURL, { organization: initial.organization !== false, teams: false });
    if (organizationId) await page.request.post("/api/auth/organization/delete", { data: { organizationId }, headers });
  }
});

// admin storageState (project default). Toggles the server-wide teams setting.
test("organization teams: create, rename, add and remove a member, delete", { tag: "@exclusive" }, async ({ page, baseURL }) => {
  test.slow();
  const headers = { origin: baseURL ?? "" };
  const caps = await (await page.request.get("/api/account/capabilities")).json();
  test.skip(!caps?.organization, "organizations not enabled");

  const stamp = Date.now();
  const orgName = `Teams UI ${stamp}`;
  const created = await page.request.post("/api/auth/organization/create", {
    data: { name: orgName, slug: `teams-ui-${stamp}` },
    headers,
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const organizationId = (await created.json()).id as string;

  try {
    // Off by default: no Teams action on the organization row.
    await setTeams(page, baseURL, false);
    await ready(page, "/admin/organizations");
    const row = page.getByRole("row", { name: new RegExp(orgName) });
    await expect(row.getByRole("button", { name: "Manage" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Teams", exact: true })).toHaveCount(0);

    // The seeded user joins the organization so it can be added to a team.
    const users = await page.request.get(`/api/auth/admin/list-users?searchValue=${encodeURIComponent(USER.email)}&searchField=email`);
    const userId = ((await users.json()).users as Array<{ id: string; email: string }>).find((u) => u.email === USER.email)?.id;
    expect(userId).toBeTruthy();
    const joined = await page.request.post("/api/account/org-member", { data: { organizationId, userId, role: "member" }, headers });
    expect(joined.ok(), await joined.text()).toBeTruthy();

    await setTeams(page, baseURL, true);
    await ready(page, "/admin/organizations");
    const teamsRow = page.getByRole("row", { name: new RegExp(orgName) });
    await expect(teamsRow.getByRole("button", { name: "Manage" })).toBeVisible();
    // The organizations page is application-owned: an app updated from a version
    // without teams keeps its own page until it renders the Teams dialog.
    const teamsAction = teamsRow.getByRole("button", { name: "Teams", exact: true });
    test.skip((await teamsAction.count()) === 0, "the organizations page does not render the Teams action");
    await teamsAction.click();
    const dialog = page.getByRole("dialog", { name: new RegExp(orgName) });
    await expect(dialog.getByText("No teams yet.")).toBeVisible();

    await dialog.getByLabel("Team name").fill("Design");
    await dialog.getByRole("button", { name: "Create team" }).click();
    await expect(page.getByText("Team created").first()).toBeVisible();
    await expect(dialog.getByRole("cell", { name: "Design", exact: true })).toBeVisible();

    // Rename in its own dialog.
    await dialog.getByRole("row", { name: /Design/ }).getByRole("button", { name: "Rename" }).click();
    const rename = page.getByRole("dialog", { name: "Rename team" });
    await rename.getByLabel("Team name").fill("Design systems");
    await rename.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Team renamed").first()).toBeVisible();
    await expect(dialog.getByRole("cell", { name: "Design systems", exact: true })).toBeVisible();

    // Members: add the seeded user, then remove them.
    await dialog.getByRole("row", { name: /Design systems/ }).getByRole("button", { name: "Members" }).click();
    await expect(dialog.getByText("Members of Design systems")).toBeVisible();
    await expect(dialog.getByText("No members in this team.")).toBeVisible();
    await dialog.locator("#team-member-pick").click();
    await page.getByRole("option", { name: new RegExp(USER.email.replace(/[.+]/g, "\\$&")) }).click();
    await dialog.getByRole("button", { name: "Add to team" }).click();
    await expect(page.getByText("Member added").first()).toBeVisible();
    const memberRow = dialog.getByRole("row", { name: new RegExp(USER.email.replace(/[.+]/g, "\\$&")) });
    await expect(memberRow).toBeVisible();
    await memberRow.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("Member removed").first()).toBeVisible();
    await expect(dialog.getByText("No members in this team.")).toBeVisible();

    await dialog.getByRole("button", { name: "Back to teams" }).click();
    await dialog.getByRole("row", { name: /Design systems/ }).getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("Team deleted").first()).toBeVisible();
    await expect(dialog.getByText("No teams yet.")).toBeVisible();
  } finally {
    await page.keyboard.press("Escape").catch(() => undefined);
    await setTeams(page, baseURL, false);
    await page.request.post("/api/auth/organization/delete", { data: { organizationId }, headers });
  }
});
