import { beforeEach, describe, expect, it } from "@jest/globals";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { HostGitRoot } from "../hosts/host-git-root.entity";
import { HostService } from "../hosts/host-service.entity";
import { Host } from "../hosts/host.entity";
import { HostsService } from "../hosts/hosts.service";
import { fakeAgentReleases } from "../testing/fake-agent-releases";
import { fakeDataSource } from "../testing/fake-data-source";
import { FakeRepository } from "../testing/fake-repository";
import { AgentRegistryService, type AgentSocket } from "./agent-registry.service";
import type { PublishedRelease } from "./agent-release.service";
import { AgentUpdateService, MAX_FAILURES, MAX_IN_FLIGHT } from "./agent-update.service";

const ORG = "org-a";

/** A digest that satisfies the contract's hex pattern; the value is irrelevant. */
function digest(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function release(version: string, platforms: { os: string; arch: string }[]): PublishedRelease {
  return {
    version,
    artifacts: platforms.map((platform) => ({
      os: platform.os,
      arch: platform.arch,
      path: `/agent/${version}/pdmux-agent-${platform.os}-${platform.arch}`,
      sha256: digest(`${platform.arch[0] ?? "a"}`),
      bytes: 9_000_000,
    })),
  };
}

const LINUX_AND_MAC = [
  { os: "linux", arch: "amd64" },
  { os: "darwin", arch: "arm64" },
];

/** Records what each host was sent, and lets a spec decide who is connected. */
class FakeAgents {
  readonly registry = new AgentRegistryService();
  readonly frames = new Map<string, unknown[]>();

  connect(hostId: string): void {
    const socket: AgentSocket = {
      send: (data: string) => {
        const list = this.frames.get(hostId) ?? [];
        list.push(JSON.parse(data));
        this.frames.set(hostId, list);
      },
      close: () => undefined,
    };
    this.registry.register(hostId, socket, `token-${hostId}`);
  }

  sentTo(hostId: string): unknown[] {
    return this.frames.get(hostId) ?? [];
  }
}

async function build(releases: PublishedRelease[] = [release("1.2.0", LINUX_AND_MAC)]): Promise<{
  updates: AgentUpdateService;
  hosts: HostsService;
  hostRepo: FakeRepository<Host>;
  agents: FakeAgents;
}> {
  const hostRepo = new FakeRepository<Host>({ tags: [], capabilities: [], sortOrder: 0, enabled: true });
  const serviceRepo = new FakeRepository<HostService>();
  const settings = new FleetSettingsService(new FakeRepository<FleetSetting>().asRepository());
  const gitRootRepo = new FakeRepository<HostGitRoot>();
  const hosts = new HostsService(
    hostRepo.asRepository(),
    serviceRepo.asRepository(),
    gitRootRepo.asRepository(),
    settings,
    fakeAgentReleases(releases),
    fakeDataSource(),
  );
  const agents = new FakeAgents();
  return {
    updates: new AgentUpdateService(hosts, agents.registry, fakeAgentReleases(releases)),
    hosts,
    hostRepo,
    agents,
  };
}

/** A host that has connected once, so it has a platform and a version on record. */
async function seedHost(
  ctx: Awaited<ReturnType<typeof build>>,
  label: string,
  platform: { os: string; arch: string },
  agentVersion: string | null = "1.1.0",
): Promise<Host> {
  const host = await ctx.hosts.create(ORG, { label });
  await ctx.hostRepo.update({ id: host.id }, { ...platform, agentVersion });
  return ctx.hosts.get(ORG, host.id);
}

async function expectAppException(promise: Promise<unknown>, code: string, status: number): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code, statusCode: status });
}

describe("[TC-PDHOST-011] the agent update command", () => {
  let ctx: Awaited<ReturnType<typeof build>>;

  beforeEach(async () => {
    ctx = await build();
  });

  it("refuses an offline host with 409 rather than queueing a frame nobody reads", async () => {
    const host = await seedHost(ctx, "build-01", { os: "linux", arch: "amd64" });
    await expectAppException(ctx.updates.updateHost(ORG, host.id), "HOST_OFFLINE", 409);
    expect(ctx.agents.sentTo(host.id)).toEqual([]);
  });

  it("sends each host the artifact for ITS platform, as a path and never a URL", async () => {
    const linux = await seedHost(ctx, "build-01", { os: "linux", arch: "amd64" });
    const mac = await seedHost(ctx, "laptop", { os: "darwin", arch: "arm64" });
    ctx.agents.connect(linux.id);
    ctx.agents.connect(mac.id);

    await ctx.updates.updateHost(ORG, linux.id);
    await ctx.updates.updateHost(ORG, mac.id);

    expect(ctx.agents.sentTo(linux.id)[0]).toMatchObject({
      type: "update",
      update: {
        version: "1.2.0",
        artifactPath: "/agent/1.2.0/pdmux-agent-linux-amd64",
        os: "linux",
        arch: "amd64",
        // The contract's own default travels rather than a second copy of it.
        probationSec: 300,
        force: false,
      },
    });
    expect(ctx.agents.sentTo(mac.id)[0]).toMatchObject({
      update: { artifactPath: "/agent/1.2.0/pdmux-agent-darwin-arm64", arch: "arm64" },
    });
  });

  it("matches a host that reports the previous agent's platform spelling", async () => {
    // The Node agent said `x64` where Go says `amd64`. Without the alias map such a
    // host matches no artifact and can never be offered the update that fixes it.
    const host = await seedHost(ctx, "legacy", { os: "linux", arch: "x64" });
    ctx.agents.connect(host.id);

    const command = await ctx.updates.updateHost(ORG, host.id);

    expect(command.version).toBe("1.2.0");
    // The frame carries the ARTIFACT's spelling — the agent compares it against
    // its own runtime values.
    expect(command.arch).toBe("amd64");
  });

  it("refuses when nothing is published for the host's platform, and when the named version is not published", async () => {
    const windows = await seedHost(ctx, "surface", { os: "windows", arch: "amd64" });
    const linux = await seedHost(ctx, "build-01", { os: "linux", arch: "amd64" });
    ctx.agents.connect(windows.id);
    ctx.agents.connect(linux.id);

    await expectAppException(ctx.updates.updateHost(ORG, windows.id), "AGENT_RELEASE_UNAVAILABLE", 409);
    await expectAppException(
      ctx.updates.updateHost(ORG, linux.id, { version: "9.9.9" }),
      "AGENT_RELEASE_UNAVAILABLE",
      409,
    );
    expect(ctx.agents.sentTo(windows.id)).toEqual([]);
    expect(ctx.agents.sentTo(linux.id)).toEqual([]);
  });

  it("refuses a manifest whose artifact path is an absolute URL", async () => {
    // The contract rejects it; this asserts the server never works around that,
    // because one such frame is "every host fetches bytes from another origin".
    const hostile: PublishedRelease = {
      version: "1.3.0",
      artifacts: [
        {
          os: "linux",
          arch: "amd64",
          path: "https://evil.example/pdmux-agent",
          sha256: digest("a"),
          bytes: 10,
        },
      ],
    };
    ctx = await build([hostile]);
    const host = await seedHost(ctx, "build-01", { os: "linux", arch: "amd64" });
    ctx.agents.connect(host.id);

    await expectAppException(ctx.updates.updateHost(ORG, host.id), "AGENT_RELEASE_INVALID", 409);
    expect(ctx.agents.sentTo(host.id)).toEqual([]);
  });

  it("keeps another organization out", async () => {
    const host = await seedHost(ctx, "build-01", { os: "linux", arch: "amd64" });
    ctx.agents.connect(host.id);
    await expectAppException(ctx.updates.updateHost("org-b", host.id), "HOST_NOT_FOUND", 404);
    expect(ctx.agents.sentTo(host.id)).toEqual([]);
  });
});

describe("[TC-PDHOST-011] a fleet update is bounded by a canary and stops early", () => {
  it("refuses the whole batch until some host has run the build", async () => {
    const ctx = await build();
    const hosts = [
      await seedHost(ctx, "a", { os: "linux", arch: "amd64" }, "1.1.0"),
      await seedHost(ctx, "b", { os: "linux", arch: "amd64" }, "1.1.0"),
    ];
    for (const host of hosts) ctx.agents.connect(host.id);

    await expectAppException(
      ctx.updates.updateFleet(ORG, { hostIds: hosts.map((h) => h.id), version: "1.2.0" }),
      "NO_CANARY",
      409,
    );
    for (const host of hosts) expect(ctx.agents.sentTo(host.id)).toEqual([]);
  });

  it("proceeds once one host is already running the target version", async () => {
    const ctx = await build();
    const canary = await seedHost(ctx, "canary", { os: "linux", arch: "amd64" }, "1.2.0");
    const rest = [
      await seedHost(ctx, "a", { os: "linux", arch: "amd64" }, "1.1.0"),
      await seedHost(ctx, "b", { os: "linux", arch: "amd64" }, "1.1.0"),
    ];
    for (const host of [canary, ...rest]) ctx.agents.connect(host.id);

    const result = await ctx.updates.updateFleet(ORG, {
      hostIds: rest.map((host) => host.id),
      version: "1.2.0",
    });

    expect(result).toMatchObject({ requested: 2, stopped: false, summary: "started 2 of 2" });
    expect(result.failed).toEqual([]);
    expect(result.notAttempted).toEqual([]);
    for (const host of rest) expect(ctx.agents.sentTo(host.id)).toHaveLength(1);
  });

  it("stops after two failures and reports what it never touched", async () => {
    const ctx = await build();
    await seedHost(ctx, "canary", { os: "linux", arch: "amd64" }, "1.2.0");
    const batch: Host[] = [];
    for (let index = 0; index < 12; index += 1) {
      batch.push(await seedHost(ctx, `host-${index}`, { os: "linux", arch: "amd64" }, "1.1.0"));
    }
    // Nobody is connected, so every attempt fails with HOST_OFFLINE.
    const result = await ctx.updates.updateFleet(ORG, {
      hostIds: batch.map((host) => host.id),
      version: "1.2.0",
    });

    expect(result.stopped).toBe(true);
    expect(result.started).toEqual([]);
    // The stop is not retroactive, and cannot be: attempts already running when
    // the second failure lands still finish. That bounds the overshoot at the
    // other two workers, and the report says exactly how many were really tried.
    expect(result.failed.length).toBeGreaterThanOrEqual(MAX_FAILURES);
    expect(result.failed.length).toBeLessThanOrEqual(MAX_FAILURES + MAX_IN_FLIGHT - 1);
    expect(result.failed.every((failure) => failure.code === "HOST_OFFLINE")).toBe(true);
    expect(result.failed.length + result.notAttempted.length).toBe(12);
    expect(result.summary).toBe(
      `stopped after ${result.failed.length} of 12 failed; ${result.notAttempted.length} not attempted`,
    );
    // "not attempted" must mean exactly that.
    for (const hostId of result.notAttempted) expect(ctx.agents.sentTo(hostId)).toEqual([]);
  });

  it("counts a duplicated host once", async () => {
    const ctx = await build();
    await seedHost(ctx, "canary", { os: "linux", arch: "amd64" }, "1.2.0");
    const host = await seedHost(ctx, "a", { os: "linux", arch: "amd64" }, "1.1.0");
    ctx.agents.connect(host.id);

    const result = await ctx.updates.updateFleet(ORG, {
      hostIds: [host.id, host.id, host.id],
      version: "1.2.0",
    });

    expect(result.requested).toBe(1);
    expect(ctx.agents.sentTo(host.id)).toHaveLength(1);
  });

  it("does not accept another organization's host as the canary", async () => {
    const ctx = await build();
    // The build runs somewhere, just not in this fleet.
    const foreign = await ctx.hosts.create("org-b", { label: "theirs" });
    await ctx.hostRepo.update({ id: foreign.id }, { os: "linux", arch: "amd64", agentVersion: "1.2.0" });
    const mine = await seedHost(ctx, "mine", { os: "linux", arch: "amd64" }, "1.1.0");
    ctx.agents.connect(mine.id);

    await expectAppException(
      ctx.updates.updateFleet(ORG, { hostIds: [mine.id], version: "1.2.0" }),
      "NO_CANARY",
      409,
    );
  });
});
