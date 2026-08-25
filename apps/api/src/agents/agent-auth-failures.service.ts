import { ProductLogger } from "../logging/product-logger";
import { IsNull, Repository } from "typeorm";

import type { AgentRefusalReason } from "@pdmux/protocol";
import { HostsService } from "../hosts/hosts.service";
import { AgentAuthFailure } from "./agent-auth-failure.entity";

/** How many rows the admin screen reads. Far more than a healthy fleet produces. */
const RECENT_LIMIT = 200;

/** A source address is required by the schema; this stands in when there is none. */
const UNKNOWN_SOURCE = "unknown";

/** What an administrator sees. No credential material, masked or otherwise. */
export interface AgentAuthFailureView {
  id: string;
  reason: AgentRefusalReason;
  hostId: string | null;
  /** Null when the host is gone or was never named — the row still stands alone. */
  hostLabel: string | null;
  sourceIp: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export class AgentAuthFailuresService {
  private readonly logger = new ProductLogger(AgentAuthFailuresService.name);

  constructor(
    private readonly failures: Repository<AgentAuthFailure>,
    private readonly hosts: HostsService,
  ) {}

  /**
   * Fold one refusal into its row.
   *
   * ⚠ ONE UPSERT ON (reason, hostId, sourceIp), NEVER AN INSERT. The caller is the
   * gateway's refusal ladder, and the thing being recorded is by nature repetitive —
   * an orphaned agent reconnects on a backoff forever. A plain insert would put a
   * row on the table every few seconds, for the same sentence, until somebody
   * noticed the disk. The conflict target is what holds that to one row, and the
   * migration declares it `NULLS NOT DISTINCT` so the two reasons with a NULL
   * `hostId` collapse as well.
   *
   * ⚠ THE COUNT IS READ BEFORE IT IS WRITTEN, so two refusals landing in the same
   * instant can tally as one. That is deliberate and it is the smaller of two
   * evils: `count = count + 1` cannot be expressed through the repository API, and
   * dropping to raw SQL here would put this write outside the discipline
   * `fake-repository.ts` exists to keep — where a service is exercised against real
   * rows rather than a mock that agrees with it. The invariant this table has to
   * hold is the ROW count, not the tally, and that one the conflict target
   * guarantees regardless of concurrency. An operator reads "thousands, still
   * climbing", never a number they audit.
   */
  async record(reason: AgentRefusalReason, hostId: string | null, sourceIp: string | null): Promise<void> {
    const source = sourceIp ?? UNKNOWN_SOURCE;
    const now = new Date();
    try {
      // `IsNull()` rather than `null`: TypeORM builds `= NULL` from a bare null,
      // which matches nothing — the same trap the unique constraint needed
      // `NULLS NOT DISTINCT` for, one layer up.
      const existing = await this.failures.findOne({
        where: { reason, hostId: hostId ?? IsNull(), sourceIp: source },
      });
      await this.failures.upsert(
        {
          reason,
          hostId,
          sourceIp: source,
          count: (existing?.count ?? 0) + 1,
          // Preserved across every later refusal: "since when" is half the answer.
          firstSeenAt: existing?.firstSeenAt ?? now,
          lastSeenAt: now,
        },
        ["reason", "hostId", "sourceIp"],
      );
    } catch (error) {
      // ⚠ BOOKKEEPING MUST NOT CHANGE THE REFUSAL. If this table is unreachable the
      // connection is still refused, on time, for the same reason — a diagnostic
      // that can turn a 401 into a 500 is worse than no diagnostic.
      this.logger.warn(`Record agent auth failure failed reason=${reason}: ${String(error)}`);
    }
  }

  /**
   * Newest first, for the admin screen.
   *
   * Host labels are resolved here rather than joined: there is no foreign key (see
   * the entity for why), and a page of refusals names a handful of distinct hosts
   * at most — a machine being refused thousands of times is still one row.
   */
  async recent(): Promise<AgentAuthFailureView[]> {
    const rows = await this.failures.find({ order: { lastSeenAt: "DESC" }, take: RECENT_LIMIT });
    const labels = new Map<string, string | null>();
    for (const id of new Set(rows.map((row) => row.hostId).filter((id): id is string => id !== null))) {
      // Scope-free on purpose: this endpoint is administrators only, and a refusal
      // an administrator cannot see is a refusal nobody can act on.
      const host = await this.hosts.getById(id);
      labels.set(id, host?.label ?? null);
    }
    return rows.map((row) => ({
      id: row.id,
      reason: row.reason,
      hostId: row.hostId,
      hostLabel: row.hostId ? (labels.get(row.hostId) ?? null) : null,
      sourceIp: row.sourceIp,
      count: row.count,
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
    }));
  }
}
