import {
  agentConfigSchema,
  type AgentCloudflaredConfig,
  type AgentConfig,
  type AgentServiceConfig,
} from "@pdmux/protocol";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import type { FleetSettings } from "../fleet/fleet-settings";
import { resolveGitRoots } from "../hosts/git-roots";
import { HostGitRootsService } from "../hosts/host-git-roots.service";
import type { HostGitRoot } from "../hosts/host-git-root.entity";
import { HostServicesService } from "../hosts/host-services.service";
import type { HostService } from "../hosts/host-service.entity";
import { CloudflareService } from "../integrations/cloudflare.service";

/**
 * Builds the `config` the server pushes to an agent.
 *
 * WHY THE SERVER OWNS IT: the agent is installed on a machine you may not be able
 * to touch again. Intervals, the git window and the probe list therefore travel
 * over the wire on every connect, so changing them is a settings edit here rather
 * than an SSH session there.
 */
export class AgentConfigService {
  constructor(
    private readonly settings: FleetSettingsService,
    private readonly services: HostServicesService,
    private readonly gitRoots: HostGitRootsService,
    private readonly cloudflare?: CloudflareService,
  ) {}

  async build(hostId: string, organizationId: string): Promise<AgentConfig> {
    const settings = await this.settings.resolve(organizationId);
    const services = await this.services.listForHost(hostId);
    const roots = await this.gitRoots.listForHost(hostId);
    const cloudflared = await this.cloudflare?.agentConnector(hostId) ?? {
      enabled: false,
      token: "",
      checkIntervalSec: 86_400,
    };
    return buildAgentConfig(settings, services, roots, cloudflared);
  }
}

export function buildAgentConfig(
  settings: FleetSettings,
  services: HostService[],
  gitRoots: HostGitRoot[] = [],
  cloudflared: AgentCloudflaredConfig = { enabled: false, token: "", checkIntervalSec: 86_400 },
): AgentConfig {
  const probes: AgentServiceConfig[] = services
    // ⚠ HALF OF WHAT "off" MEANS, and the half that costs something: a disabled
    // service must stop being probed every heartbeat. Leaving it in would keep
    // opening sockets to a port somebody deliberately stopped watching, and the
    // card would keep a red dot that means nothing.
    //
    // ⚠ `!== false`, NOT TRUTHINESS. The column is NOT NULL so a row from the
    // database always answers — but the two failure directions are not
    // symmetrical. Treating a missing value as "off" silently stops watching a
    // service nobody turned off, and nothing on the screen would say why; the
    // other way round costs one probe on a row that should not have existed.
    // Only an explicit `false` may stop a probe.
    .filter((service) => service.enabled !== false)
    // `probe: none` services are links only — sending them would make the agent
    // open sockets to ports nobody asked it to check.
    .filter((service) => service.probe !== "none")
    .map((service) => ({
      id: service.id,
      port: service.port,
      probe: service.probe,
      path: service.path || "/",
    }));
  // Parse rather than cast: the config is a protocol frame, and an out-of-range
  // value must fail here — on the server — not on every agent that receives it.
  return agentConfigSchema.parse({
    heartbeatSec: settings.heartbeatSec,
    gitIntervalSec: settings.gitIntervalSec,
    gitRoots: resolveGitRoots(settings, gitRoots),
    gitLimit: settings.gitLimit,
    gitDetailBudget: settings.gitDetailBudget,
    services: probes,
    usageProviders: settings.usageProviders,
    usageIntervalSec: settings.usageIntervalSec,
    probeTimeoutMs: settings.probeTimeoutMs,
    statusFileCap: settings.statusFileCap,
    bodyMaxChars: settings.bodyMaxChars,
    terminalBufferBytes: settings.terminalBufferBytes,
    cloudflared,
  });
}
