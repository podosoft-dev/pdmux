import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * What the agent gateway refused, and how often — the thing an administrator had no
 * way to see.
 *
 * WHY IT EXISTS AT ALL: the refusal ladder in `agent.gateway.ts` answered 401 and
 * 403 and LOGGED NOTHING (only the 429 branch did). An agent whose host was deleted,
 * or whose token was revoked, retries forever, and the only evidence was a socket
 * being hung up on. Salt's `salt-key -L` is the precedent — the master lists the
 * minions it is refusing, because "why is this machine not appearing" is the
 * question, and the answer lives on the server.
 *
 * WHY AN AGGREGATE AND NOT AN AUDIT ROW PER ATTEMPT — two independent reasons, and
 * either one alone would be enough:
 *
 *  1. The normal HTTP audit hook cannot reach this. It records completed requests,
 *     while a refused WebSocket upgrade is rejected before the HTTP handler runs.
 *  2. One row per attempt is unbounded. The failure this table exists to surface is
 *     precisely the one that repeats forever — an orphaned agent reconnecting on a
 *     backoff — so a per-attempt log would grow without limit while saying the same
 *     sentence over and over. What an operator needs is "this, from here, 4,812
 *     times since Tuesday", which is one row.
 *
 * ⚠ `NULLS NOT DISTINCT` IS LOAD-BEARING, NOT DECORATION. `hostId` is NULL for the
 * two reasons decided before a token resolves (`missing_key`, `unknown`), and under
 * Postgres's default a UNIQUE constraint treats every NULL as distinct — so those
 * rows would conflict with NOTHING, every retry would INSERT, and the table would
 * grow exactly the way this design exists to prevent. Available since Postgres 15;
 * this deployment runs 16.
 *
 * ⚠ NO FOREIGN KEY ON `hostId`, ON PURPOSE. `host_deleted` is one of the reasons
 * recorded here, so a cascade would delete precisely the rows that explain why a
 * machine is being refused, at the moment they become the only explanation left.
 * The column is an identifier to look up, not a relationship to enforce.
 *
 * ⚠ Additive on purpose — a new table, invisible to the code running before it, so
 * it can be applied while the server is up.
 */
export class AddAgentAuthFailures1730800000000 implements MigrationInterface {
  name = "AddAgentAuthFailures1730800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "agent_auth_failures" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "reason" character varying(32) NOT NULL,
        "hostId" uuid,
        "sourceIp" character varying(45) NOT NULL,
        "count" integer NOT NULL DEFAULT 1,
        "firstSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "lastSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agent_auth_failures" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_agent_auth_failures_key"
          UNIQUE NULLS NOT DISTINCT ("reason", "hostId", "sourceIp")
      )
    `);
    // The list is read newest-first and nothing else; one index for the one query.
    await queryRunner.query(
      `CREATE INDEX "IDX_agent_auth_failures_lastSeenAt" ON "agent_auth_failures" ("lastSeenAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_agent_auth_failures_lastSeenAt"`);
    await queryRunner.query(`DROP TABLE "agent_auth_failures"`);
  }
}
