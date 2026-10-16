import type { MigrationInterface, QueryRunner } from "typeorm";

// The admin session list pages active sessions newest first with a keyset on
// ("createdAt", "id"). Better Auth's schema indexes only "userId" and "token",
// so without this index every page sorts the whole session table.
const INDEX = "IDX_session_createdAt_id";

export class IndexSessionCreatedAt1792060000000 implements MigrationInterface {
  name = "IndexSessionCreatedAt1792060000000";
  // CONCURRENTLY cannot run inside a transaction block. The runner therefore
  // uses the "each" transaction mode. SQLite migrations always use one.
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== "postgres") {
      await queryRunner.query(`CREATE INDEX IF NOT EXISTS "${INDEX}" ON "session" ("createdAt", "id")`);
      return;
    }
    // Sign-ins keep writing sessions while the index builds. An interrupted
    // build leaves an invalid index that IF NOT EXISTS would keep.
    const invalid = await queryRunner.query(
      `SELECT 1 AS "invalid" FROM pg_index WHERE indexrelid = to_regclass($1) AND NOT indisvalid`,
      [`"${INDEX}"`],
    ) as unknown[];
    if (invalid.length > 0) await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX}"`);
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${INDEX}" ON "session" ("createdAt", "id")`,
    );
  }

  // A revert runs inside a transaction, so it uses a plain statement.
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "${INDEX}"`);
  }
}
