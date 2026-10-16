import type { MigrationInterface, QueryRunner } from "typeorm";

// The admin session list pages active sessions newest first with a keyset on
// ("createdAt", "id"). Better Auth's schema indexes only "userId" and "token",
// so without this index every page sorts the whole session table.
const INDEX = "IDX_session_createdAt_id";

// Better Auth creates "session" in its own schema step. `migrate:all` runs that
// step before the application migrations; `migration:run` does not.
const MISSING_SESSION_TABLE =
  'Better Auth has not created the "session" table yet. Run "bun run --cwd apps/api migrate:all", ' +
  "which applies the Better Auth schema before the application migrations.";

export class IndexSessionCreatedAt1792060000000 implements MigrationInterface {
  name = "IndexSessionCreatedAt1792060000000";
  // CONCURRENTLY cannot run inside a transaction block. The runner therefore
  // uses the "each" transaction mode. SQLite migrations always use one.
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== "postgres") {
      try {
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "${INDEX}" ON "session" ("createdAt", "id")`);
      } catch (error) {
        if (error instanceof Error && /no such table: (?:main\.)?session$/.test(error.message)) {
          throw new Error(MISSING_SESSION_TABLE, { cause: error });
        }
        throw error;
      }
      return;
    }
    const [session] = await queryRunner.query(
      `SELECT to_regclass($1) IS NOT NULL AS "exists"`,
      [`"session"`],
    ) as Array<{ exists: boolean } | undefined>;
    if (!session?.exists) throw new Error(MISSING_SESSION_TABLE);
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
