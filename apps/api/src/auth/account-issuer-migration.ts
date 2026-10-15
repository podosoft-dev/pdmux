import type { Database as SqliteDatabase } from "bun:sqlite";
import type { Pool } from "pg";

type MigrationRow = Record<string, unknown>;

export interface AccountIssuerMigrationClient {
  query<Row extends MigrationRow>(sql: string, values?: readonly unknown[]): Promise<readonly Row[]>;
  release(): void;
}

export interface AccountIssuerMigrationDatabase {
  connect(): Promise<AccountIssuerMigrationClient>;
}

export type AccountIssuerMigrationResult = "absent" | "current" | "migrated";

function readCount(rows: readonly MigrationRow[]): number {
  const value = rows[0]?.count;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  throw new Error("Cannot read account identity collision count");
}

function assertNoCollisions(count: number): void {
  if (count > 0) {
    throw new Error("Cannot upgrade Better Auth: duplicate providerId and accountId identities require manual resolution");
  }
}

export function postgresAccountIssuerMigrationDatabase(pool: Pool): AccountIssuerMigrationDatabase {
  return {
    connect: async (): Promise<AccountIssuerMigrationClient> => {
      const client = await pool.connect();
      return {
        query: async <Row extends MigrationRow>(sql: string, values?: readonly unknown[]): Promise<readonly Row[]> => {
          const result = await client.query<Row>(sql, values === undefined ? undefined : [...values]);
          return result.rows;
        },
        release: (): void => client.release(),
      };
    },
  };
}

/** Relax the obsolete 1.7.0-1.7.2 issuer schema for Better Auth 1.7.3 and later. */
export async function migrateLegacyAccountIssuers(
  database: AccountIssuerMigrationDatabase,
): Promise<AccountIssuerMigrationResult> {
  const client = await database.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SELECT pg_advisory_xact_lock(1886350955, 1)");
    const tableRows = await client.query<{ exists: boolean }>(`
      SELECT to_regclass('"account"') IS NOT NULL AS "exists"
    `);
    if (tableRows[0]?.exists !== true) {
      await client.query("COMMIT");
      transactionOpen = false;
      return "absent";
    }
    await client.query('LOCK TABLE "account" IN SHARE ROW EXCLUSIVE MODE');
    const collisions = await client.query<MigrationRow>(`
      SELECT COUNT(*)::int AS "count" FROM (
        SELECT "providerId", "accountId" FROM "account"
        GROUP BY "providerId", "accountId" HAVING COUNT(*) > 1
      ) AS collisions
    `);
    assertNoCollisions(readCount(collisions));
    const columns = await client.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = '"account"'::regclass AND attname = 'issuer' AND NOT attisdropped
      ) AS "exists"
    `);
    await client.query('DROP TRIGGER IF EXISTS podokit_fill_legacy_account_issuer ON "account"');
    await client.query('DROP INDEX IF EXISTS "account_issuer_accountId_uidx"');
    if (columns[0]?.exists === true) {
      await client.query('ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL');
    }
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS "account_providerId_accountId_uidx" ON "account" ("providerId", "accountId")');
    await client.query("COMMIT");
    transactionOpen = false;
    return columns[0]?.exists === true ? "migrated" : "current";
  } catch (error: unknown) {
    if (transactionOpen) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** SQLite follows the upstream cleanup: remove the unused issuer column. */
export function migrateSqliteLegacyAccountIssuers(database: SqliteDatabase): AccountIssuerMigrationResult {
  database.run("BEGIN IMMEDIATE");
  try {
    const table = database.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'account'",
    ).get();
    if (!table) {
      database.run("COMMIT");
      return "absent";
    }
    const collision = database.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM (
        SELECT "providerId", "accountId" FROM "account"
        GROUP BY "providerId", "accountId" HAVING COUNT(*) > 1
      )
    `).get();
    assertNoCollisions(readCount(collision ? [collision] : []));
    const hasIssuer = database.query<{ name: string }, []>('PRAGMA table_info("account")').all()
      .some((column) => column.name === "issuer");
    database.run('DROP INDEX IF EXISTS "account_issuer_accountId_uidx"');
    if (hasIssuer) database.run('ALTER TABLE "account" DROP COLUMN "issuer"');
    database.run('CREATE UNIQUE INDEX IF NOT EXISTS "account_providerId_accountId_uidx" ON "account" ("providerId", "accountId")');
    database.run("COMMIT");
    return hasIssuer ? "migrated" : "current";
  } catch (error: unknown) {
    database.run("ROLLBACK");
    throw error;
  }
}
