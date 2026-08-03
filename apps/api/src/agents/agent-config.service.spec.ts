import { describe, expect, it } from "@jest/globals";
import { agentConfigSchema } from "@pdmux/protocol";
import { FLEET_SETTING_DEFAULTS, resolveFleetSettings } from "../fleet/fleet-settings";
import type { HostGitRoot } from "../hosts/host-git-root.entity";
import type { HostService } from "../hosts/host-service.entity";
import { buildAgentConfig } from "./agent-config.service";

function root(partial: Partial<HostGitRoot>): HostGitRoot {
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    hostId: "00000000-0000-4000-8000-0000000000ff",
    path: "/srv/work",
    enabled: true,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  } as HostGitRoot;
}

function service(partial: Partial<HostService>): HostService {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    hostId: "00000000-0000-4000-8000-0000000000ff",
    label: "api",
    port: 5002,
    probe: "tcp",
    path: "/",
    urlTemplate: null,
    sortOrder: 0,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  } as HostService;
}

describe("[TC-PDAGENT-058] agent config", () => {
  it("is built from org settings plus the host's probeable services", () => {
    const settings = resolveFleetSettings([
      { key: "heartbeatSec", value: "10" },
      { key: "gitRoots", value: JSON.stringify(["/home/ubuntu/work"]) },
      { key: "gitLimit", value: "500" },
    ]);

    const config = buildAgentConfig(settings, [
      service({ id: "00000000-0000-4000-8000-000000000001", label: "api", port: 5002, probe: "http", path: "/health" }),
      // A link-only service must not become a socket the agent opens.
      service({ id: "00000000-0000-4000-8000-000000000002", label: "docs", port: 8080, probe: "none" }),
    ]);

    expect(config.heartbeatSec).toBe(10);
    expect(config.gitRoots).toEqual(["/home/ubuntu/work"]);
    expect(config.gitLimit).toBe(500);
    expect(config.gitIntervalSec).toBe(FLEET_SETTING_DEFAULTS.gitIntervalSec);
    // Server-controlled collector knobs travel with the rest of the config, so
    // changing one is a settings edit here rather than an SSH session there.
    expect(config.usageIntervalSec).toBe(FLEET_SETTING_DEFAULTS.usageIntervalSec);
    expect(config.probeTimeoutMs).toBe(FLEET_SETTING_DEFAULTS.probeTimeoutMs);
    expect(config.statusFileCap).toBe(FLEET_SETTING_DEFAULTS.statusFileCap);
    expect(config.bodyMaxChars).toBe(FLEET_SETTING_DEFAULTS.bodyMaxChars);
    expect(config.terminalBufferBytes).toBe(FLEET_SETTING_DEFAULTS.terminalBufferBytes);
    expect(config.services).toEqual([
      { id: "00000000-0000-4000-8000-000000000001", port: 5002, probe: "http", path: "/health" },
    ]);
    // What we send must be a legal frame for every agent that receives it.
    expect(agentConfigSchema.safeParse(config).success).toBe(true);
  });

  it("[TC-PDAGENT-058] stops probing a service that was turned off", () => {
    // The half of "off" that costs something. A disabled service left in this
    // list keeps the agent opening a socket to a port somebody deliberately
    // parked, every heartbeat, forever — and keeps a red dot on the card that
    // means nothing, because nobody is coming to fix it.
    const config = buildAgentConfig(resolveFleetSettings([]), [
      service({ id: "00000000-0000-4000-8000-000000000001", label: "api", port: 5002 }),
      service({ id: "00000000-0000-4000-8000-000000000002", label: "old", port: 9999, enabled: false }),
    ]);
    expect(config.services.map((probe) => probe.port)).toEqual([5002]);
  });

  it("[TC-PDHOST-020] a host's own git roots replace the fleet list, whole", () => {
    // ⚠ REPLACE, NOT ADD TO. These are absolute paths on ONE machine. A union
    // would hand every host the other machines' paths, and each host would then
    // report `git.root_missing` for the ones it does not have — so the warning
    // that is supposed to mean "you typo'd" would also mean "this path belongs to
    // a different computer", and it would stop being worth reading.
    const settings = resolveFleetSettings([{ key: "gitRoots", value: JSON.stringify(["/fleet/one"]) }]);

    // No rows: today's behaviour, unchanged. This is what every host looks like the
    // day this ships, which is why it needs no migration.
    expect(buildAgentConfig(settings, [], []).gitRoots).toEqual(["/fleet/one"]);

    expect(buildAgentConfig(settings, [], [root({ path: "/home/dev/work" })]).gitRoots).toEqual([
      "/home/dev/work",
    ]);
  });

  it("[TC-PDHOST-020] rows that are all off mean 'scan nothing', not 'use the fleet'", () => {
    // Turning every root off is a decision. Falling back to the fleet's paths there
    // would quietly re-enable scanning somebody just switched off — and on a host
    // where those paths do not exist, it would do it while raising a warning.
    const settings = resolveFleetSettings([{ key: "gitRoots", value: JSON.stringify(["/fleet/one"]) }]);
    const off = [root({ path: "/home/dev/work", enabled: false })];
    expect(buildAgentConfig(settings, [], off).gitRoots).toEqual([]);
  });

  it("[TC-PDHOST-020] trims to the contract's cap instead of failing the whole config", () => {
    // ⚠ THE FAILURE THIS PREVENTS IS A HOST THAT CANNOT CONNECT AT ALL.
    // `agentConfigSchema.gitRoots` is `.max(32)` and this builder parses rather
    // than casts, so a 33rd root throws — and the gateway does not swallow it, it
    // answers `ws.close(1011, "config unavailable")`. One path too many would take
    // the machine off the dashboard with nothing on screen to say why.
    const settings = resolveFleetSettings([]);
    const many = Array.from({ length: 40 }, (_, index) => root({ path: `/srv/r${index}` }));
    const config = buildAgentConfig(settings, [], many);
    expect(config.gitRoots).toHaveLength(32);
    expect(agentConfigSchema.safeParse(config).success).toBe(true);
  });

  it("[TC-PDHOST-020] the same path twice is one root", () => {
    // The unique index stops this per host, but a fleet list and a host list can
    // still agree, and a duplicate costs a second walk of the same tree for nothing.
    const settings = resolveFleetSettings([]);
    const dupes = [root({ path: "/srv/a" }), root({ path: " /srv/a " }), root({ path: "/srv/b" })];
    expect(buildAgentConfig(settings, [], dupes).gitRoots).toEqual(["/srv/a", "/srv/b"]);
  });

  it("[TC-PDAGENT-058] keeps probing when nothing said to stop", () => {
    // ⚠ THE TWO FAILURE DIRECTIONS ARE NOT SYMMETRICAL, so the test states the
    // safe one. Reading a missing value as "off" would silently stop watching a
    // service nobody turned off, with nothing on screen to say why. The other way
    // costs one probe. Only an explicit `false` may stop one.
    const config = buildAgentConfig(resolveFleetSettings([]), [
      service({ id: "00000000-0000-4000-8000-000000000003", label: "api", port: 5002, enabled: undefined }),
    ]);
    expect(config.services.map((probe) => probe.port)).toEqual([5002]);
  });

  it("clamps out-of-range stored settings instead of shipping them to the fleet", () => {
    const settings = resolveFleetSettings([
      { key: "heartbeatSec", value: "0" },
      { key: "gitIntervalSec", value: "999999" },
      { key: "metricStepSec", value: "not-a-number" },
      { key: "terminalBufferBytes", value: "1" },
      { key: "probeTimeoutMs", value: "999999" },
      { key: "unknownKey", value: "ignored" },
    ]);

    expect(settings.heartbeatSec).toBe(1);
    expect(settings.gitIntervalSec).toBe(86_400);
    expect(settings.metricStepSec).toBe(FLEET_SETTING_DEFAULTS.metricStepSec);
    expect(settings.terminalBufferBytes).toBe(4096);
    expect(settings.probeTimeoutMs).toBe(10_000);
    expect(agentConfigSchema.safeParse(buildAgentConfig(settings, [])).success).toBe(true);
  });

  it("falls back to defaults with no stored rows at all", () => {
    const config = buildAgentConfig(resolveFleetSettings([]), []);
    expect(config.heartbeatSec).toBe(FLEET_SETTING_DEFAULTS.heartbeatSec);
    expect(config.gitDetailBudget).toBe(FLEET_SETTING_DEFAULTS.gitDetailBudget);
    expect(config.usageProviders).toEqual(FLEET_SETTING_DEFAULTS.usageProviders);
    expect(config.services).toEqual([]);
  });
});
