import { beforeEach, describe, expect, it } from "@jest/globals";
import type { AgentConfig } from "@pdmux/protocol";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { HostService } from "../hosts/host-service.entity";
import { HostGitRootsService } from "../hosts/host-git-roots.service";
import { HostGitRoot } from "../hosts/host-git-root.entity";
import { HostServicesService } from "../hosts/host-services.service";
import { Host } from "../hosts/host.entity";
import { HostsService } from "../hosts/hosts.service";
import { fakeAgentReleases } from "../testing/fake-agent-releases";
import { fakeDataSource } from "../testing/fake-data-source";
import { FakeRepository } from "../testing/fake-repository";
import { AgentConfigPushService } from "./agent-config-push.service";
import { AgentConfigService } from "./agent-config.service";
import { AgentRegistryService, type AgentSocket } from "./agent-registry.service";

const ORG_A = "org-a";
const ORG_B = "org-b";

/** Records what the server wrote to one agent; can be made to fail like a closing one. */
class RecordingSocket implements AgentSocket {
  readonly sent: { type: string; config?: AgentConfig }[] = [];
  failing = false;

  send(data: string): void {
    if (this.failing) throw new Error("socket closed");
    this.sent.push(JSON.parse(data) as { type: string; config?: AgentConfig });
  }

  close(): void {
    this.failing = true;
  }

  configs(): AgentConfig[] {
    return this.sent.filter((frame) => frame.type === "config").map((frame) => frame.config as AgentConfig);
  }
}

function build(): {
  settings: FleetSettingsService;
  hosts: HostsService;
  services: HostServicesService;
  gitRoots: HostGitRootsService;
  config: AgentConfigService;
  registry: AgentRegistryService;
} {
  const hostRepo = new FakeRepository<Host>({ tags: [], capabilities: [], sortOrder: 0, enabled: true });
  const serviceRepo = new FakeRepository<HostService>({ sortOrder: 0, probe: "tcp", path: "/" });
  const settings = new FleetSettingsService(new FakeRepository<FleetSetting>().asRepository());
  const gitRootRepo = new FakeRepository<HostGitRoot>();
  const hosts = new HostsService(
    hostRepo.asRepository(),
    serviceRepo.asRepository(),
    gitRootRepo.asRepository(),
    settings,
    fakeAgentReleases(),
    fakeDataSource(),
  );
  const services = new HostServicesService(serviceRepo.asRepository(), hosts);
  // ⚠ THE PUSHER NOW REGISTERS ON THREE SERVICES, not two — a git root belongs to
  // one host exactly as a service does, so it pushes through the same seam.
  const gitRoots = new HostGitRootsService(gitRootRepo.asRepository(), hosts);
  const config = new AgentConfigService(settings, services, gitRoots);
  const registry = new AgentRegistryService();
  // The seam under test: the pusher registers itself on the two services from the
  // agents side, exactly as Nest does at startup.
  new AgentConfigPushService(settings, services, gitRoots, hosts, config, registry).onModuleInit();
  return { settings, hosts, services, gitRoots, config, registry };
}

describe("[TC-PDHOST-012] a settings change reaches the agents that are connected now", () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it("[TC-PDHOST-012] sends one config frame per connected host in the scope, and to nobody else", async () => {
    const online = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const second = await ctx.hosts.create(ORG_A, { label: "build-02" });
    const offline = await ctx.hosts.create(ORG_A, { label: "build-03" });
    const foreign = await ctx.hosts.create(ORG_B, { label: "other-org" });

    const onlineSocket = new RecordingSocket();
    const secondSocket = new RecordingSocket();
    const foreignSocket = new RecordingSocket();
    ctx.registry.register(online.id, onlineSocket, "token-online");
    ctx.registry.register(second.id, secondSocket, "token-second");
    ctx.registry.register(foreign.id, foreignSocket, "token-foreign");

    const saved = await ctx.settings.update(ORG_A, { gitRoots: ["/srv/checkouts"], heartbeatSec: 9 });
    expect(saved.gitRoots).toEqual(["/srv/checkouts"]);

    // One frame each — not one per changed key, and not a broadcast.
    expect(onlineSocket.configs()).toHaveLength(1);
    expect(secondSocket.configs()).toHaveLength(1);
    expect(onlineSocket.configs()[0]?.gitRoots).toEqual(["/srv/checkouts"]);
    expect(onlineSocket.configs()[0]?.heartbeatSec).toBe(9);
    // A host with no socket is not queued for: its `welcome` carries the new value.
    expect(ctx.registry.isConnected(offline.id)).toBe(false);
    // Another organization's agent must never learn this scope's settings.
    expect(foreignSocket.sent).toEqual([]);
  });

  it("[TC-PDHOST-012] pushes exactly the config a reconnect would build", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    await ctx.services.create(ORG_A, host.id, { label: "api", port: 5002, probe: "http", path: "/health" });
    // Link-only rows are not probes, so they must be absent from both paths alike.
    await ctx.services.create(ORG_A, host.id, { label: "docs", port: 8080, probe: "none" });
    const socket = new RecordingSocket();
    ctx.registry.register(host.id, socket, "token-1");

    await ctx.settings.update(ORG_A, { probeTimeoutMs: 4000, usageProviders: ["claude"] });

    // `welcome` is built through the same service; the push must not be a second
    // opinion about what this host is configured to do.
    const welcome = await ctx.config.build(host.id, ORG_A);
    expect(socket.configs().at(-1)).toEqual(welcome);
    expect(welcome.services).toEqual([
      { id: expect.any(String) as unknown as string, port: 5002, probe: "http", path: "/health" },
    ]);
  });

  it("[TC-PDHOST-012] swallows a failing send: the save still succeeds and the other host is still pushed", async () => {
    const broken = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const healthy = await ctx.hosts.create(ORG_A, { label: "build-02" });
    const brokenSocket = new RecordingSocket();
    const healthySocket = new RecordingSocket();
    ctx.registry.register(broken.id, brokenSocket, "token-broken");
    ctx.registry.register(healthy.id, healthySocket, "token-healthy");
    // The socket is mid-close: every write throws.
    brokenSocket.close();

    const saved = await ctx.settings.update(ORG_A, { gitIntervalSec: 300 });

    // The write is what the operator asked for and it happened; a dead socket is
    // not their problem and must not surface as a 500.
    expect(saved.gitIntervalSec).toBe(300);
    expect(await ctx.settings.resolve(ORG_A)).toMatchObject({ gitIntervalSec: 300 });
    expect(brokenSocket.sent).toEqual([]);
    // One host's failure does not cut the fan-out short.
    expect(healthySocket.configs()).toHaveLength(1);
    expect(healthySocket.configs()[0]?.gitIntervalSec).toBe(300);
  });

  it("[TC-PDHOST-012] pushes a service edit only to the host that owns the service", async () => {
    const owner = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const bystander = await ctx.hosts.create(ORG_A, { label: "build-02" });
    const ownerSocket = new RecordingSocket();
    const bystanderSocket = new RecordingSocket();
    ctx.registry.register(owner.id, ownerSocket, "token-owner");
    ctx.registry.register(bystander.id, bystanderSocket, "token-bystander");

    const created = await ctx.services.create(ORG_A, owner.id, { label: "api", port: 5002 });
    expect(ownerSocket.configs()).toHaveLength(1);
    expect(ownerSocket.configs()[0]?.services).toEqual([
      { id: created.id, port: 5002, probe: "tcp", path: "/" },
    ]);

    await ctx.services.update(ORG_A, owner.id, created.id, { port: 5099 });
    expect(ownerSocket.configs()[1]?.services).toEqual([
      { id: created.id, port: 5099, probe: "tcp", path: "/" },
    ]);

    // A removed service is a port the agent must stop opening.
    await ctx.services.remove(ORG_A, owner.id, created.id);
    expect(ownerSocket.configs()).toHaveLength(3);
    expect(ownerSocket.configs()[2]?.services).toEqual([]);

    // Nothing about the other machine changed, so it hears nothing.
    expect(bystanderSocket.sent).toEqual([]);
  });
});
