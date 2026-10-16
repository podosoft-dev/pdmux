import type { MigrationInterface, QueryRunner } from "typeorm";

// Indexes for the keyset list: ("createdAt", "id") serves the unfiltered pages and
// the retention prune, and each filter gets its column followed by "createdAt".
// PostgreSQL builds and drops them concurrently so audit writes continue on a
// large table. IF NOT EXISTS keeps indexes an operator already built.
const INDEXES: Array<[name: string, columns: string]> = [
  ["IDX_audit_logs_createdAt_id", `"createdAt", "id"`],
  ["IDX_audit_logs_action_createdAt", `"action", "createdAt"`],
  ["IDX_audit_logs_actorEmail_createdAt", `"actorEmail", "createdAt"`],
  ["IDX_audit_logs_targetLabel_createdAt", `"targetLabel", "createdAt"`],
];

const REPLACED: Array<[name: string, columns: string]> = [
  ["IDX_audit_logs_action", `"action"`],
  ["IDX_audit_logs_createdAt", `"createdAt"`],
];

export class IndexAuditLogFilters1792000000000 implements MigrationInterface {
  name = "IndexAuditLogFilters1792000000000";
  // CONCURRENTLY cannot run inside a transaction block. The runner therefore
  // uses the "each" transaction mode. SQLite migrations always use one.
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== "postgres") {
      for (const [name, columns] of INDEXES) {
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "${name}" ON "audit_logs" (${columns})`);
      }
      for (const [name] of REPLACED) await queryRunner.query(`DROP INDEX IF EXISTS "${name}"`);
      return;
    }
    for (const [name, columns] of INDEXES) {
      // An interrupted concurrent build leaves an invalid index that
      // IF NOT EXISTS would keep, so drop it and build again.
      const invalid = await queryRunner.query(
        `SELECT 1 AS "invalid" FROM pg_index WHERE indexrelid = to_regclass($1) AND NOT indisvalid`,
        [`"${name}"`],
      ) as unknown[];
      if (invalid.length > 0) await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
      await queryRunner.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${name}" ON "audit_logs" (${columns})`,
      );
    }
    for (const [name] of REPLACED) {
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
    }
  }

  // A revert runs inside a transaction, so it uses plain statements.
  async down(queryRunner: QueryRunner): Promise<void> {
    for (const [name, columns] of REPLACED) {
      await queryRunner.query(`CREATE INDEX IF NOT EXISTS "${name}" ON "audit_logs" (${columns})`);
    }
    for (const [name] of INDEXES) await queryRunner.query(`DROP INDEX IF EXISTS "${name}"`);
  }
}
