import { beforeEach, describe, expect, it } from "bun:test";
import { AppException } from "../common/app-exception";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { HostGitRoot } from "../hosts/host-git-root.entity";
import { HostService } from "../hosts/host-service.entity";
import { Host } from "../hosts/host.entity";
import { HostsService } from "../hosts/hosts.service";
import { fakeAgentReleases } from "../testing/fake-agent-releases";
import { fakeDataSource } from "../testing/fake-data-source";
import { FakeRepository } from "../testing/fake-repository";
import { PrefsService } from "./prefs.service";
import { UserHostPref } from "./user-host-pref.entity";
import { UserLayout } from "./user-layout.entity";

const ORG_A = "org-a";
const ORG_B = "org-b";
const ALICE = "user-alice";
const BOB = "user-bob";

function build(): { prefs: PrefsService; hosts: HostsService } {
  const hostRepo = new FakeRepository<Host>({ tags: [], capabilities: [], sortOrder: 0, enabled: true });
  const settings = new FleetSettingsService(new FakeRepository<FleetSetting>().asRepository());
  const gitRootRepo = new FakeRepository<HostGitRoot>();
  const hosts = new HostsService(
    hostRepo.asRepository(),
    new FakeRepository<HostService>().asRepository(),
    gitRootRepo.asRepository(),
    settings,
    fakeAgentReleases(),
    fakeDataSource(),
  );
  const layouts = new FakeRepository<UserLayout>({ isDefault: false, updatedAt: new Date() });
  const hostPrefs = new FakeRepository<UserHostPref>({ updatedAt: new Date() });
  return { prefs: new PrefsService(layouts.asRepository(), hostPrefs.asRepository(), hosts), hosts };
}

describe("PrefsService", () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it("[TC-PDUSER-001] round-trips layouts and per-host widgets for the session user", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });

    await ctx.prefs.putLayout(ALICE, "work", { grid: "2x2", panes: [{ machine: "build-01" }] }, true);
    await ctx.prefs.putHostPref(ALICE, ORG_A, host.id, { agents: true, resources: false });

    const mine = await ctx.prefs.read(ALICE);
    expect(mine.layouts).toHaveLength(1);
    expect(mine.layouts[0]?.payload).toEqual({ grid: "2x2", panes: [{ machine: "build-01" }] });
    expect(mine.hostPrefs[host.id]).toEqual({ agents: true, resources: false });

    // Another user's personalisation is another user's.
    expect(await ctx.prefs.read(BOB)).toEqual({ layouts: [], hostPrefs: {} });

    // Saving the same name again replaces it rather than piling up rows.
    await ctx.prefs.putLayout(ALICE, "work", { grid: "3x3" }, true);
    const updated = await ctx.prefs.read(ALICE);
    expect(updated.layouts).toHaveLength(1);
    expect(updated.layouts[0]?.payload).toEqual({ grid: "3x3" });
  });

  it("[TC-PDUSER-002] keeps exactly one default layout per user", async () => {
    await ctx.prefs.putLayout(ALICE, "work", { grid: "2x2" }, true);
    await ctx.prefs.putLayout(ALICE, "night", { grid: "1x1" }, true);
    await ctx.prefs.putLayout(BOB, "bob-default", { grid: "4x4" }, true);

    const alice = await ctx.prefs.read(ALICE);
    expect(alice.layouts.filter((layout) => layout.isDefault).map((l) => l.name)).toEqual(["night"]);
    // Demotion never crosses the user boundary.
    const bob = await ctx.prefs.read(BOB);
    expect(bob.layouts[0]?.isDefault).toBe(true);
  });

  it("[TC-PDUSER-004] validates layout names and deletes by name", async () => {
    await expect(ctx.prefs.putLayout(ALICE, "", {}, false)).rejects.toBeInstanceOf(AppException);
    await expect(ctx.prefs.putLayout(ALICE, "x".repeat(65), {}, false)).rejects.toBeInstanceOf(AppException);
    await expect(ctx.prefs.putLayout(ALICE, "../etc", {}, false)).rejects.toBeInstanceOf(AppException);

    await ctx.prefs.putLayout(ALICE, "work", { grid: "2x2" }, false);
    expect(await ctx.prefs.deleteLayout(ALICE, "work")).toEqual({ name: "work" });
    await expect(ctx.prefs.deleteLayout(ALICE, "work")).rejects.toBeInstanceOf(AppException);
    // Deleting someone else's layout by name is a 404, not a silent success.
    await ctx.prefs.putLayout(BOB, "work", { grid: "2x2" }, false);
    await expect(ctx.prefs.deleteLayout(ALICE, "work")).rejects.toBeInstanceOf(AppException);
  });

  it("[TC-PDUSER-003] refuses a host preference outside the caller's scope", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });

    await expect(ctx.prefs.putHostPref(ALICE, ORG_B, host.id, { agents: true })).rejects.toBeInstanceOf(
      AppException,
    );
    expect(await ctx.prefs.read(ALICE)).toEqual({ layouts: [], hostPrefs: {} });
  });
});
