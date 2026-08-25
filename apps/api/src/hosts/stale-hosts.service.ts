import { ProductLogger } from "../logging/product-logger";
import { LessThan, Repository } from "typeorm";
import { recordAudit } from "../audit/audit-events";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { Host } from "./host.entity";
import { staleCutoff } from "./stale-hosts";

export interface StaleHostSweep {
  /** Scopes looked at — including the ones that have the sweep turned off. */
  scopes: number;
  /** Scopes that opted in (`staleHostRetentionDays > 0`). */
  armed: number;
  removed: number;
}

/**
 * Deletes hosts that have not reported for longer than their scope's window.
 *
 * ⚠ THIS IS THE ONLY THING IN THE PRODUCT THAT DELETES A HOST NOBODY POINTED AT,
 * so every part of it is written to be refused by default and to leave a trail.
 *
 * OFF UNLESS ASKED: `staleHostRetentionDays` ships as 0 and `staleCutoff` answers
 * `null` for it, so a fleet that never opens the setting is never swept. See the
 * field's own comment for why any other default would delete machines at the
 * moment of upgrade.
 *
 * A HOST THAT NEVER CONNECTED IS NEVER SWEPT. `lastSeenAt IS NULL` is not "very
 * old" — it is a row somebody created minutes ago and has not finished running
 * the installer against. SQL already excludes NULL from `<`, but the rule is
 * restated in TypeScript below rather than left to that: it is the difference
 * between "we relied on a comparison's null semantics" and "we decided". The
 * hosts list has a filter for exactly these rows so a person can act on them.
 *
 * PER-SCOPE, NOT GLOBAL, for the same reason metric retention is: the window is
 * an organization's setting, and one tenant's 30 days must not be another's 7.
 *
 * ⚠ IT DELETES THROUGH THE REPOSITORY, NOT `HostsService.remove()`, and therefore
 * does not fire the removed-listener that hangs up on a live agent. That is
 * sound only because of what this sweep selects: the minimum window is a full
 * day, so every row it takes has been silent for at least that long and has no
 * socket to close. The sweep also runs in the worker process, where the gateway
 * that owns those sockets does not exist.
 */
export class StaleHostsService {
  private readonly logger = new ProductLogger(StaleHostsService.name);

  constructor(
    private readonly hosts: Repository<Host>,
    private readonly settings: FleetSettingsService,
  ) {}

  async runOnce(now: Date = new Date()): Promise<StaleHostSweep> {
    const scopes = await this.scopeIds();
    let armed = 0;
    let removed = 0;

    for (const organizationId of scopes) {
      const { staleHostRetentionDays } = await this.settings.resolve(organizationId);
      const cutoff = staleCutoff(now, staleHostRetentionDays);
      if (!cutoff) continue;
      armed += 1;
      removed += await this.sweepScope(organizationId, cutoff, staleHostRetentionDays);
    }

    if (removed > 0) {
      this.logger.log(`Remove stale hosts removed=${removed} scopes=${armed}`);
    }
    return { scopes: scopes.length, armed, removed };
  }

  /** Distinct scopes that own at least one host — tens of them, not thousands. */
  private async scopeIds(): Promise<string[]> {
    const rows = await this.hosts.find({ select: { id: true, organizationId: true } });
    return [...new Set(rows.map((row) => row.organizationId))];
  }

  /**
   * ONE HOST AT A TIME, and a failure does not stop the rest.
   *
   * Deleting a host is not one row going away: the cascade takes its services,
   * tokens, enrollment codes and collected history with it, and firing a scope's
   * worth of those at once is load nobody asked for on a database that is also
   * serving somebody's live dashboard. Serial is also the only order in which the
   * audit entries mean anything individually.
   */
  private async sweepScope(organizationId: string, cutoff: Date, retentionDays: number): Promise<number> {
    const candidates = await this.hosts.find({
      where: { organizationId, lastSeenAt: LessThan(cutoff) },
      select: { id: true, label: true, lastSeenAt: true },
    });
    // Restated rather than inherited from SQL — see the class comment.
    const doomed = candidates.filter((host) => host.lastSeenAt !== null);

    let removed = 0;
    for (const host of doomed) {
      try {
        await this.hosts.delete({ id: host.id });
      } catch (error) {
        this.logger.warn(`Remove stale host failed host=${host.id} scope=${organizationId}: ${String(error)}`);
        continue;
      }
      removed += 1;
      // ⚠ AFTER THE DELETE, AND ONLY ON SUCCESS. An entry for a deletion that did
      // not happen is worse than no entry: this trail is the only record that the
      // machine was ever registered, so it has to describe what is actually gone.
      // There is no actor — nobody pressed anything — so the trail says why
      // instead of inventing a who.
      // `host.prune`, not `host.autoDelete`: every other action in this trail is
      // lowercase dot-separated (`host.create`, `agent.token.rotate`), and
      // hosts.audit.spec.ts pins that shape for controller routes. This one is
      // written outside the request pipeline, so nothing would have caught a
      // camelCase name — which is exactly why it is worth matching by hand.
      await recordAudit({
        action: "host.prune",
        targetType: "host",
        targetId: host.id,
        targetLabel: host.label,
        metadata: {
          organizationId,
          reason: "stale",
          retentionDays,
          lastSeenAt: host.lastSeenAt?.toISOString() ?? null,
        },
      });
    }
    return removed;
  }
}
