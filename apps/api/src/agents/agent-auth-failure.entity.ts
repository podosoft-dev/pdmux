import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from "typeorm";

import type { AgentRefusalReason } from "@pdmux/protocol";

/**
 * One row per (reason, host, source address) — not per attempt.
 *
 * The refusal ladder in `agent.gateway.ts` used to answer 401/403 and record
 * nothing, so an agent whose host had been deleted retried forever with no trace an
 * administrator could find. This is that trace, and it is an AGGREGATE because the
 * failure worth surfacing is the one that repeats: what an operator needs is "this,
 * from here, 4,812 times since Tuesday", which is a single row that gets touched
 * again, not a log that grows without limit.
 *
 * ⚠ IT CARRIES NO CREDENTIAL, NOT EVEN A MASKED ONE. A refused secret is still a
 * secret — most of them are real tokens that were revoked, and a table of "nearly
 * valid" material is a target. `reason` says what happened, `hostId` says whose
 * machine (when the token got far enough to name one), and `sourceIp` says from
 * where. That is the whole of it.
 *
 * ⚠ NULL `hostId` IS A REAL KEY VALUE HERE. `missing_key` and `unknown` are decided
 * before any token resolves, so there is no host to name — and the unique
 * constraint is declared `NULLS NOT DISTINCT` in the migration precisely so those
 * rows still collapse into one. Under Postgres's default they would not, and every
 * retry would insert.
 */
@Entity("agent_auth_failures")
@Unique("UQ_agent_auth_failures_key", ["reason", "hostId", "sourceIp"])
@Index(["lastSeenAt"])
export class AgentAuthFailure {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** One of `AGENT_REFUSAL_REASONS` — the vocabulary the protocol package owns. */
  @Column({ type: "varchar", length: 32 })
  reason!: AgentRefusalReason;

  /**
   * Whose machine, when the presented secret named one. NULL for the refusals
   * decided before that.
   *
   * ⚠ NO FOREIGN KEY, deliberately: `host_deleted` is one of the reasons stored
   * here, and a cascade would erase the rows explaining a refusal at the exact
   * moment they became the only explanation left.
   */
  @Column({ type: "uuid", nullable: true })
  hostId!: string | null;

  /** Wide enough for IPv6, as `agent_enrollments.consumedIp` already is. */
  @Column({ type: "varchar", length: 45 })
  sourceIp!: string;

  @Column({ type: "int", default: 1 })
  count!: number;

  @Column({ type: "timestamptz", default: () => "now()" })
  firstSeenAt!: Date;

  @Column({ type: "timestamptz", default: () => "now()" })
  lastSeenAt!: Date;
}
