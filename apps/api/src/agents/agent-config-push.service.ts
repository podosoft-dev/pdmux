import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { HostGitRootsService } from "../hosts/host-git-roots.service";
import { HostServicesService } from "../hosts/host-services.service";
import { HostsService } from "../hosts/hosts.service";
import { AgentConfigService } from "./agent-config.service";
import { AgentRegistryService } from "./agent-registry.service";

/**
 * Delivers a settings change to the agents that are connected RIGHT NOW.
 *
 * WHY THIS EXISTS: the contract has a `config` frame and the agent adopts it live —
 * `applyConfig` retunes the heartbeat and git timers, the usage collector and the
 * terminal buffer without a reconnect, deliberately, because a server raising a
 * probe timeout is reacting to a host misbehaving at that moment. Without a
 * producer for that frame the whole mechanism was dead: an edit only reached a
 * machine on its next reconnect, so `PUT /fleet/settings` changed `gitRoots` and
 * both connected agents kept scanning the old path (and kept reporting
 * `git.root_missing`) until someone restarted them by hand.
 *
 * WHY IT IS PER HOST: the config is per host — the services block is that machine's
 * probe list — so a scope-wide change is N different frames, not one broadcast.
 * It is built through `AgentConfigService`, the same call the gateway makes for
 * `welcome`, so a push and a reconnect cannot disagree about what the fleet is
 * configured to do.
 *
 * WHY OFFLINE HOSTS ARE SKIPPED RATHER THAN QUEUED: an agent asks for its config as
 * the first thing it does, and `welcome` carries the current one. A queue would be
 * a second delivery path holding stale copies of a value the reconnect already
 * answers correctly.
 */
@Injectable()
export class AgentConfigPushService implements OnModuleInit {
  private readonly logger = new Logger(AgentConfigPushService.name);

  constructor(
    private readonly settings: FleetSettingsService,
    private readonly hostServices: HostServicesService,
    private readonly hostGitRoots: HostGitRootsService,
    private readonly hosts: HostsService,
    private readonly config: AgentConfigService,
    private readonly registry: AgentRegistryService,
  ) {}

  /**
   * Register from this side, so neither `fleet` nor `hosts` has to know the agents
   * module exists. Same seam as `HostsService.setConnectedProbe` /
   * `setEnrollmentIssuer`: `AgentsModule` already imports both of those modules, so
   * the dependency only runs one way and no `forwardRef` is needed.
   */
  onModuleInit(): void {
    this.settings.setChangeListener((organizationId) => this.pushScope(organizationId));
    this.hostServices.setChangeListener((hostId, organizationId) =>
      this.pushHost(hostId, organizationId),
    );
    // Same shape as the services listener: a git root belongs to one machine, so
    // one host's config moved and nobody else's did.
    this.hostGitRoots.setChangeListener((hostId, organizationId) =>
      this.pushHost(hostId, organizationId),
    );
  }

  /** Every connected host in one scope, after a fleet-settings edit. */
  async pushScope(organizationId: string): Promise<void> {
    const hostIds = await this.hosts.listIds(organizationId);
    const connected = hostIds.filter((hostId) => this.registry.isConnected(hostId));
    if (connected.length === 0) return;
    // Sequential on purpose: N is the connected fleet, each step is two small reads
    // plus a socket write, and doing them in order keeps one slow host from being
    // interleaved into another's failure log. `pushHost` never throws, so one bad
    // socket cannot cut the loop short.
    for (const hostId of connected) await this.pushHost(hostId, organizationId);
    this.logger.log(`Pushed config to ${connected.length} host(s) scope=${organizationId}`);
  }

  /**
   * One host.
   *
   * ⚠ NEVER THROWS. Callers reach this from a mutation that has already committed
   * (a settings save, a service edit), and a socket that closed while the frame was
   * being built must not turn that completed write into a 500.
   */
  async pushHost(hostId: string, organizationId: string): Promise<void> {
    if (!this.registry.isConnected(hostId)) return;
    try {
      const config = await this.config.build(hostId, organizationId);
      // `sendToHost` reports an absent or broken socket as `false` rather than
      // throwing; either way the agent picks the change up in its next `welcome`.
      if (!this.registry.sendToHost(hostId, { type: "config", config })) {
        this.logger.warn(`Config push undelivered host=${hostId}: the socket went away mid-push`);
      }
    } catch (error) {
      this.logger.warn(`Config push failed host=${hostId}: ${String(error)}`);
    }
  }
}
