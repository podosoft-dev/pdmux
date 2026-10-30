import { beforeEach, describe, expect, it } from "bun:test";
import type { UpdateStatus } from "@pdmux/protocol";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { HostGitRoot } from "../hosts/host-git-root.entity";
import { HostService } from "../hosts/host-service.entity";
import { Host } from "../hosts/host.entity";
import { HostsService } from "../hosts/hosts.service";
import { fakeAgentReleases } from "../testing/fake-agent-releases";
import { fakeDataSource } from "../testing/fake-data-source";
import { FakeRepository } from "../testing/fake-repository";
import { AUTO_UPDATE_TIMEOUT_MS, AgentAutoUpdateService } from "./agent-auto-update.service";
import { AgentRegistryService, type AgentSocket } from "./agent-registry.service";
import type { PublishedRelease } from "./agent-release.service";
import { AgentUpdateService } from "./agent-update.service";

const ORG = "org-a";
const LATEST = "1.2.0";

function release(version: string): PublishedRelease {
  return {
    version,
    artifacts: [{ os: "linux", arch: "amd64", path: `/agent/${version}/pdmux-agent-linux-amd64`, sha256: "a".repeat(64), bytes: 9_000_000 }],
  };
}

async function build(): Promise<{
  auto: AgentAutoUpdateService;
  hosts: HostsService;
  hostRepo: FakeRepository<Host>;
  settings: FleetSettingsService;
  frames: Map<string, { type: string; update: { version: string; commandId: string } }[]>;
  connect: (hostId: string) => void;
  clock: { now: number };
}> {
  const hostRepo = new FakeRepository<Host>({ tags: [], capabilities: [], sortOrder: 0, enabled: true });
  const settings = new FleetSettingsService(new FakeRepository<FleetSetting>().asRepository());
  const releases = fakeAgentReleases([release(LATEST), release("1.1.0")]);
  const hosts = new HostsService(
    hostRepo.asRepository(),
    new FakeRepository<HostService>().asRepository(),
    new FakeRepository<HostGitRoot>().asRepository(),
    settings,
    releases,
    fakeDataSource(),
  );
  const registry = new AgentRegistryService();
  const frames = new Map<string, { type: string; update: { version: string; commandId: string } }[]>();
  const connect = (hostId: string): void => {
    const socket: AgentSocket = {
      send: (data: string) => {
        frames.set(hostId, [...(frames.get(hostId) ?? []), JSON.parse(data)]);
      },
      close: () => undefined,
    };
    registry.register(hostId, socket, `token-${hostId}`);
  };
  const clock = { now: 1_000_000 };
  const updates = new AgentUpdateService(hosts, registry, releases);
  const auto = new AgentAutoUpdateService(hosts, registry, releases, updates, settings, () => clock.now);
  return { auto, hosts, hostRepo, settings, frames, connect, clock };
}

describe("[TC-PDHOST-037] automatic agent updates", () => {
  let ctx: Awaited<ReturnType<typeof build>>;

  beforeEach(async () => {
    ctx = await build();
  });

  async function host(label: string, agentVersion: string, connected = true): Promise<string> {
    const created = await ctx.hosts.create(ORG, { label });
    await ctx.hostRepo.update({ id: created.id }, { os: "linux", arch: "amd64", agentVersion });
    if (connected) ctx.connect(created.id);
    return created.id;
  }

  async function hello(hostId: string): Promise<void> {
    ctx.auto.handleEvent({ type: "host.hello", hostId });
    await ctx.auto.idle();
  }

  async function report(hostId: string, phase: UpdateStatus["phase"], agentVersion?: string): Promise<void> {
    const sent = ctx.frames.get(hostId)?.at(-1);
    await ctx.hostRepo.update(
      { id: hostId },
      {
        ...(agentVersion ? { agentVersion } : {}),
        lastUpdate: { commandId: sent?.update.commandId ?? crypto.randomUUID(), phase, progressPct: null, currentVersion: agentVersion ?? "1.1.0", targetVersion: LATEST, code: null, message: "", shellPanes: 0, sessionPanes: 0 },
      },
    );
    ctx.auto.handleEvent({ type: "host.update", hostId });
    await ctx.auto.idle();
  }

  const sent = (hostId: string): string[] => (ctx.frames.get(hostId) ?? []).filter((f) => f.type === "update").map((f) => f.update.version);

  it("sends an outdated agent the newest build when it says hello, and leaves a current one alone", async () => {
    const old = await host("old", "1.1.0");
    const current = await host("current", LATEST);
    await hello(old);
    await hello(current);
    expect(sent(old)).toEqual([LATEST]);
    expect(sent(current)).toEqual([]);
  });

  it("updates a machine that was offline as soon as it connects", async () => {
    const away = await host("away", "1.1.0", false);
    await hello(away);
    expect(sent(away)).toEqual([]);
    ctx.connect(away);
    await hello(away);
    expect(sent(away)).toEqual([LATEST]);
  });

  it("does nothing when the fleet turned automatic updates off", async () => {
    await ctx.settings.update(ORG, { agentAutoUpdate: false });
    const old = await host("old", "1.1.0");
    await hello(old);
    expect(sent(old)).toEqual([]);
  });

  it("updates one host first, then up to three once one runs the new version", async () => {
    const ids = await Promise.all(["a", "b", "c", "d", "e"].map((label) => host(label, "1.1.0")));
    for (const id of ids) await hello(id);
    expect(ids.filter((id) => sent(id).length > 0)).toHaveLength(1);
    const canary = ids.find((id) => sent(id).length > 0) as string;

    await report(canary, "done", LATEST);
    // The canary finished; the rest go three at a time.
    expect(ids.filter((id) => id !== canary && sent(id).length > 0)).toHaveLength(3);
  });

  it("does not send a hello twice an update while one is on its way", async () => {
    const old = await host("old", "1.1.0");
    await hello(old);
    await report(old, "downloading");
    await hello(old);
    expect(sent(old)).toEqual([LATEST]);
  });

  it("never sends a host again the version it rolled back from", async () => {
    const old = await host("old", "1.1.0");
    await hello(old);
    await report(old, "rolledBack");
    await hello(old);
    expect(sent(old)).toEqual([LATEST]);
  });

  it("stops sending a version after two hosts fail it", async () => {
    const ids = await Promise.all(["a", "b", "c"].map((label) => host(label, "1.1.0")));
    for (const id of ids) await hello(id);
    const first = ids.find((id) => sent(id).length > 0) as string;
    await report(first, "rolledBack");
    const second = ids.find((id) => id !== first && sent(id).length > 0) as string;
    expect(second).toBeDefined();
    await report(second, "failed");
    const third = ids.find((id) => id !== first && id !== second) as string;
    await hello(third);
    expect(sent(third)).toEqual([]);
  });

  it("frees the slot of an update that never reported back", async () => {
    const [a, b] = await Promise.all([host("a", "1.1.0"), host("b", "1.1.0")]);
    await hello(a);
    await hello(b);
    const first = sent(a).length > 0 ? a : b;
    const other = first === a ? b : a;
    expect(sent(other)).toEqual([]);
    ctx.clock.now += AUTO_UPDATE_TIMEOUT_MS + 1;
    await hello(first);
    expect(sent(other)).toEqual([LATEST]);
  });
});
