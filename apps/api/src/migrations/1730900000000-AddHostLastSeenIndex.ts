import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * An index on `hosts.lastSeenAt`.
 *
 * WHY IT IS MISSING IN THE FIRST PLACE: until now nothing ever QUERIED that
 * column. It was written by every heartbeat and read back one row at a time
 * through the primary key, so the two indexes the table has
 * (`organizationId,label` unique and `organizationId,sortOrder`) covered every
 * access there was.
 *
 * WHAT CHANGED: automatic removal of stale hosts scans `lastSeenAt < cutoff` per
 * scope, on a schedule, for the whole table. Without an index that is a
 * sequential scan — free on the ten-host install it will be written against, and
 * the first thing to hurt on a large one.
 *
 * ⚠ PARTIAL, ON `lastSeenAt IS NOT NULL`. A host that never connected is never
 * swept (NULL cannot satisfy `<`, and the sweep restates that rule explicitly),
 * so those rows are dead weight in the index. Excluding them also keeps the index
 * from being the largest thing in a fleet that registers hosts faster than it
 * enrolls them.
 *
 * ⚠ Additive on purpose — a new index, invisible to the code running before it,
 * so it can be applied while the server is up. `CONCURRENTLY` is deliberately NOT
 * used: it cannot run inside the transaction TypeORM wraps a migration in, and on
 * a table sized in hosts the brief lock is not worth trading that away for.
 */
export class AddHostLastSeenIndex1730900000000 implements MigrationInterface {
  name = "AddHostLastSeenIndex1730900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_hosts_lastSeenAt" ON "hosts" ("lastSeenAt") WHERE "lastSeenAt" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_hosts_lastSeenAt"`);
  }
}
