import type { MigrationInterface, QueryRunner } from "typeorm";

// Indexes for the keyset list: ("createdAt", "id") serves the unfiltered pages and
// the retention prune, and each filter gets its column followed by "createdAt".
// IF NOT EXISTS lets an operator build them beforehand with CREATE INDEX
// CONCURRENTLY on a large PostgreSQL table; migrations run in one transaction.
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

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const [name, columns] of INDEXES) {
      await queryRunner.query(`CREATE INDEX IF NOT EXISTS "${name}" ON "audit_logs" (${columns})`);
    }
    for (const [name] of REPLACED) await queryRunner.query(`DROP INDEX IF EXISTS "${name}"`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const [name, columns] of REPLACED) {
      await queryRunner.query(`CREATE INDEX IF NOT EXISTS "${name}" ON "audit_logs" (${columns})`);
    }
    for (const [name] of INDEXES) await queryRunner.query(`DROP INDEX IF EXISTS "${name}"`);
  }
}
