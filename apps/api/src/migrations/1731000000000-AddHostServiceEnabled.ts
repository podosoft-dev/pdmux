import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * `host_services.enabled` — turning a registered service off without deleting it.
 *
 * WHY A COLUMN RATHER THAN DELETING THE ROW: a service that is down for the
 * afternoon, or one somebody registered for a container they are not running
 * today, has two costs while it stays on. The agent probes it every heartbeat,
 * so the card shows a red dot that means nothing; and it sits in the launcher
 * where it is one mis-click away. Deleting removes both, and also removes the
 * label, the probe kind, the path and the URL template the person configured —
 * so the cheapest way back is to type it all again. Off keeps the row.
 *
 * ⚠ `DEFAULT true` AND `NOT NULL` TOGETHER, DELIBERATELY. Every service that
 * exists today was registered to be watched, so the migration must not change
 * what any of them do. A nullable column would push a three-state decision
 * (on / off / never said) into every reader for no gain — there is no such thing
 * here as a service nobody has decided about.
 *
 * ⚠ Additive and safe on a running server: code that has never heard of the
 * column ignores it, which is why this migration can go first and why it cannot
 * go second (a running `nest --watch` reloads on the entity change and exits
 * against a column that does not exist yet).
 */
export class AddHostServiceEnabled1731000000000 implements MigrationInterface {
  name = "AddHostServiceEnabled1731000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "host_services" ADD COLUMN "enabled" boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "host_services" DROP COLUMN "enabled"`);
  }
}
