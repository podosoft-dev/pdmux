import { compareVersionStrings } from "@pdmux/protocol";
import type { UpdateStatus } from "@pdmux/protocol";
import { ProductLogger } from "../logging/product-logger";
import type { FleetSettingsService } from "../fleet/fleet-settings.service";
import type { HostsService } from "../hosts/hosts.service";
import type { AgentRegistryService } from "./agent-registry.service";
import type { AgentReleaseService } from "./agent-release.service";
import { MAX_FAILURES, MAX_IN_FLIGHT, type AgentUpdateService } from "./agent-update.service";

/** An update that reported nothing for this long no longer holds a slot. */
export const AUTO_UPDATE_TIMEOUT_MS = 15 * 60_000;

/** How often connected hosts are checked again, for notices a bus may have lost. */
export const AUTO_UPDATE_SWEEP_MS = 5 * 60_000;

const RUNNING: ReadonlySet<UpdateStatus["phase"]> = new Set(["accepted", "downloading", "verifying", "swapping", "restarting"]);
const FAILED: ReadonlySet<UpdateStatus["phase"]> = new Set(["failed", "rolledBack"]);

interface InFlight {
  organizationId: string;
  version: string;
  startedAt: number;
}

/**
 * Sending an outdated agent the newest build without anybody pressing a button.
 *
 * The trigger is the agent's `hello`. A deploy restarts the server, so every connected
 * agent says hello again moments later; a machine that was offline says it when it comes
 * back. One trigger therefore covers both, and the sweep only recovers notices a bus lost.
 *
 * The safety rules are the fleet update's (`AgentUpdateService`), applied over time:
 *
 * - CANARY FIRST. While no host of the organization runs the new version, one host at a
 *   time; after one has, `MAX_IN_FLIGHT`. A build that cannot start therefore reaches one
 *   machine, which rolls itself back.
 * - TWO FAILURES STOP THE VERSION. After `MAX_FAILURES` hosts report `failed` or
 *   `rolledBack` for a version, it is no longer sent automatically. A fixed release has a
 *   new version and starts again.
 * - A HOST THAT FAILED A VERSION IS NOT SENT IT AGAIN, and neither is one whose update never
 *   reported back within `AUTO_UPDATE_TIMEOUT_MS`. Retrying on every reconnect would restart
 *   its terminals over and over for the same result. Updating it by hand still works.
 *
 * The slots live in this process, which is the one holding the host's socket: a replica
 * acts only for hosts connected to it (`registry.isConnected`).
 */
export class AgentAutoUpdateService {
  private readonly logger = new ProductLogger(AgentAutoUpdateService.name);
  private readonly inFlight = new Map<string, InFlight>();
  private readonly waiting = new Set<string>();
  /** Failures per organization and version, keyed `${organizationId} ${version}`. */
  private readonly failures = new Map<string, number>();
  /** Hosts whose update of a version never reported back, keyed `${hostId} ${version}`. */
  private readonly silent = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly hosts: HostsService,
    private readonly registry: AgentRegistryService,
    private readonly releases: AgentReleaseService,
    private readonly updates: AgentUpdateService,
    private readonly settings: FleetSettingsService,
    private readonly now: () => number = Date.now,
  ) {}

  /** Reacts to `host.hello` and `host.update` notices. */
  handleEvent(event: unknown): void {
    if (typeof event !== "object" || event === null) return;
    const { type, hostId } = event as { type?: unknown; hostId?: unknown };
    if ((type === "host.hello" || type === "host.update") && typeof hostId === "string") this.schedule(hostId);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const hostId of this.registry.connectedHostIds()) this.schedule(hostId);
    }, AUTO_UPDATE_SWEEP_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Resolves once no check is left, including the ones a finished check scheduled. */
  async idle(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.chain;
      await current;
    } while (current !== this.chain);
  }

  /** Checks run one at a time, so two hellos cannot both take the last slot. */
  private schedule(hostId: string): void {
    this.chain = this.chain
      .then(() => this.check(hostId))
      .catch((error: unknown) => {
        this.logger.warn(`Check automatic agent update failed host=${hostId}: ${String(error)}`);
      });
  }

  private async check(hostId: string): Promise<void> {
    const host = await this.hosts.getById(hostId);
    const running = this.inFlight.get(hostId);
    if (running) {
      const status = host?.lastUpdate ?? null;
      const finished = !host || host.agentVersion === running.version || (status !== null && FAILED.has(status.phase));
      const expired = this.now() - running.startedAt > AUTO_UPDATE_TIMEOUT_MS;
      if (!finished && !expired) return;
      this.inFlight.delete(hostId);
      const failed = Boolean(host) && host?.agentVersion !== running.version;
      if (failed) {
        if (expired && !(status !== null && FAILED.has(status.phase))) this.silent.add(`${hostId} ${running.version}`);
        const key = `${running.organizationId} ${running.version}`;
        const count = (this.failures.get(key) ?? 0) + 1;
        this.failures.set(key, count);
        this.logger.warn(
          `Automatic agent update did not finish host=${hostId} version=${running.version} ` +
            `phase=${status?.phase ?? "none"} failures=${count}`,
        );
      }
      for (const waiting of [...this.waiting]) {
        this.waiting.delete(waiting);
        if (waiting !== hostId) this.schedule(waiting);
      }
      // The slot goes to the hosts that were waiting, not straight back to this one.
      if (failed) return;
    }
    if (!host || !host.enabled || !this.registry.isConnected(hostId)) return;

    const settings = await this.settings.resolve(host.organizationId);
    if (!settings.agentAutoUpdate) return;

    const latest = this.releases.latestFor(host.os, host.arch);
    if (!latest) return;
    const order = compareVersionStrings(host.agentVersion ?? "", latest);
    if (order === null || order >= 0) return;

    const status = host.lastUpdate ?? null;
    // Somebody's update is already on its way, by hand or from an earlier check.
    if (status !== null && RUNNING.has(status.phase) && !this.inFlight.has(hostId)) return;
    if (status !== null && FAILED.has(status.phase) && status.targetVersion === latest) return;
    if (this.silent.has(`${hostId} ${latest}`)) return;
    if ((this.failures.get(`${host.organizationId} ${latest}`) ?? 0) >= MAX_FAILURES) return;

    const canaries = await this.hosts.countAtAgentVersion(host.organizationId, latest);
    const limit = canaries > 0 ? MAX_IN_FLIGHT : 1;
    let busy = 0;
    for (const entry of this.inFlight.values()) {
      if (entry.organizationId === host.organizationId && entry.version === latest) busy += 1;
    }
    if (busy >= limit) {
      this.waiting.add(hostId);
      return;
    }

    this.inFlight.set(hostId, { organizationId: host.organizationId, version: latest, startedAt: this.now() });
    try {
      await this.updates.updateHost(host.organizationId, hostId, { version: latest });
      this.logger.log(`Started automatic agent update host=${hostId} from=${host.agentVersion} to=${latest}`);
    } catch (error) {
      this.inFlight.delete(hostId);
      this.logger.warn(`Start automatic agent update failed host=${hostId} version=${latest}: ${String(error)}`);
    }
  }
}
