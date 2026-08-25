import { beforeEach, describe, expect, it } from "bun:test";
import { AppException } from "../common/app-exception";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { fakeAgentReleases } from "../testing/fake-agent-releases";
import { fakeDataSource } from "../testing/fake-data-source";
import { FakeRepository } from "../testing/fake-repository";
import { HostServicesService } from "./host-services.service";
import { HostGitRoot } from "./host-git-root.entity";
import { HostService } from "./host-service.entity";
import { Host } from "./host.entity";
import { HostsService } from "./hosts.service";

const ORG_A = "org-a";
const ORG_B = "org-b";

function build(): { services: HostServicesService; hosts: HostsService } {
  const hostRepo = new FakeRepository<Host>({ tags: [], capabilities: [], sortOrder: 0, enabled: true });
  const serviceRepo = new FakeRepository<HostService>({ sortOrder: 0, probe: "tcp", path: "/" });
  const settings = new FleetSettingsService(new FakeRepository<FleetSetting>().asRepository());
  const gitRootRepo = new FakeRepository<HostGitRoot>();
  const hosts = new HostsService(hostRepo.asRepository(), serviceRepo.asRepository(), gitRootRepo.asRepository(), settings, fakeAgentReleases(), fakeDataSource());
  return { services: new HostServicesService(serviceRepo.asRepository(), hosts), hosts };
}

describe("HostServicesService", () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it("[TC-PDHOST-008] creates, updates and deletes services scoped through their host", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });

    const created = await ctx.services.create(ORG_A, host.id, { label: "api", port: 5002 });
    expect(created.probe).toBe("tcp");
    expect(created.path).toBe("/");

    const updated = await ctx.services.update(ORG_A, host.id, created.id, { probe: "http", path: "/health" });
    expect(updated.probe).toBe("http");

    // Same label twice on one host would make the card's picker ambiguous.
    await expect(ctx.services.create(ORG_A, host.id, { label: "api", port: 9999 })).rejects.toBeInstanceOf(
      AppException,
    );

    // Another organization cannot reach the service through its own scope.
    await expect(ctx.services.list(ORG_B, host.id)).rejects.toBeInstanceOf(AppException);
    await expect(ctx.services.remove(ORG_B, host.id, created.id)).rejects.toBeInstanceOf(AppException);

    expect(await ctx.services.remove(ORG_A, host.id, created.id)).toEqual({ id: created.id, label: "api" });
    expect(await ctx.services.list(ORG_A, host.id)).toEqual([]);
  });

  it("[TC-PDHOST-009] reorders services and rejects an id from another host", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const other = await ctx.hosts.create(ORG_A, { label: "build-02" });
    const api = await ctx.services.create(ORG_A, host.id, { label: "api", port: 5002 });
    const admin = await ctx.services.create(ORG_A, host.id, { label: "admin", port: 4000 });
    const foreign = await ctx.services.create(ORG_A, other.id, { label: "api", port: 5002 });

    const reordered = await ctx.services.reorder(ORG_A, host.id, [admin.id, api.id]);
    expect(reordered.map((s) => s.label)).toEqual(["admin", "api"]);
    expect(reordered.map((s) => s.sortOrder)).toEqual([0, 1]);

    await expect(ctx.services.reorder(ORG_A, host.id, [api.id, foreign.id])).rejects.toBeInstanceOf(AppException);
  });

  it("[TC-PDHOST-009] lists a host's services for the agent config without a session", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    await ctx.services.create(ORG_A, host.id, { label: "api", port: 5002 });

    const forAgent = await ctx.services.listForHost(host.id);
    expect(forAgent.map((s) => s.port)).toEqual([5002]);
  });
});
