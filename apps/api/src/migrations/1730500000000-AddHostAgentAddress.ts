import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Where a host says it can be reached — its own answer, not the server's guess.
 *
 * ⚠ THE SERVER CANNOT WORK THIS OUT, which is why the value has to be stored rather
 * than derived. What a server observes is the far end of a socket, and the agent dials
 * OUT: measured on this deployment, one agent arrives as `127.0.0.1` (it is the same
 * machine as the server) and another as `172.22.0.2`, a container-bridge address
 * belonging to the reverse proxy in front of it. Neither is a way back to the machine.
 * The agent, standing on the host, asks its own kernel which source address reaches the
 * server and reports that in `hello`.
 *
 * SEPARATE FROM `address`, deliberately. That column is the operator's — typed by hand,
 * the base for service links, and the one that wins wherever both exist. This one is
 * observed, and it fills the gap for a host nobody has described yet.
 *
 * Nullable, no backfill, no default. NULL means "no agent has said yet", which is the
 * correct state for every existing row: an agent built before this field simply does
 * not send it, and reports its address on the first connection after it updates.
 *
 * ⚠ Additive on purpose — invisible to the code running before it and a valid state for
 * the code running after it, so it can be applied while the server is up.
 */
export class AddHostAgentAddress1730500000000 implements MigrationInterface {
  name = "AddHostAgentAddress1730500000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "hosts" ADD COLUMN "agentAddress" character varying(255)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "hosts" DROP COLUMN "agentAddress"`);
  }
}
