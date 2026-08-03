import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * What a host's agent is running, and how its last remote update went.
 *
 * `lastUpdate` stores the newest `updateStatus` frame whole, exactly as
 * `lastHeartbeat` stores a heartbeat: the agent's update reporting will grow
 * fields, and a jsonb column lets the UI read them before this server has a
 * column for any of them. A snapshot, not a history — the audit log already
 * records who asked for what.
 *
 * `agentProtocolVersion` is the wire contract the agent announced in `hello`. It
 * is the difference between "this build is old" and "this build speaks a
 * different protocol", which is the one version verdict that is a hard statement
 * rather than advice.
 *
 * Both are nullable with no backfill: null means "this host has not connected
 * since the columns existed", which the version state already renders as
 * `unknown` — the honest answer, and never a false "outdated".
 */
export class AddHostAgentUpdate1730200000000 implements MigrationInterface {
  name = "AddHostAgentUpdate1730200000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "hosts" ADD COLUMN "agentProtocolVersion" integer`);
    await queryRunner.query(`ALTER TABLE "hosts" ADD COLUMN "lastUpdate" jsonb`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "hosts" DROP COLUMN "lastUpdate"`);
    await queryRunner.query(`ALTER TABLE "hosts" DROP COLUMN "agentProtocolVersion"`);
  }
}
