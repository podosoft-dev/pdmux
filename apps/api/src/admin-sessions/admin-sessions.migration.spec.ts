import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type { QueryRunner } from "typeorm";
import { revertLatestSqliteMigration, runSqliteMigrations } from "../database/sqlite-migrator";
import { IndexSessionCreatedAt1792060000000 } from "../migrations/1792060000000-IndexSessionCreatedAt";

function runner(
  type: "postgres" | "better-sqlite3",
  queries: string[],
  { invalid = false, session = true }: { invalid?: boolean; session?: boolean } = {},
): QueryRunner {
  return {
    connection: { options: { type } },
    query: (sql: string): Promise<unknown[]> => {
      queries.push(sql);
      if (sql.includes("IS NOT NULL")) return Promise.resolve([{ exists: session }]);
      return Promise.resolve(invalid && sql.includes("indisvalid") ? [{ invalid: 1 }] : []);
    },
  } as unknown as QueryRunner;
}

// Finalized at once: an open statement keeps SQLite from dropping an index.
function rows<Row>(database: Database, sql: string): Row[] {
  const statement = database.prepare<Row, []>(sql);
  try {
    return statement.all();
  } finally {
    statement.finalize();
  }
}

const CREATE = 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_session_createdAt_id" ON "session" ("createdAt", "id")';
const SESSION_EXISTS = 'SELECT to_regclass($1) IS NOT NULL AS "exists"';

describe("admin session list index migration", () => {
  it("builds the PostgreSQL index concurrently outside a transaction", async () => {
    const migration = new IndexSessionCreatedAt1792060000000();
    expect(migration.transaction).toBe(false);
    const up: string[] = [];
    await migration.up(runner("postgres", up));
    expect(up).toEqual([
      SESSION_EXISTS,
      "SELECT 1 AS \"invalid\" FROM pg_index WHERE indexrelid = to_regclass($1) AND NOT indisvalid",
      CREATE,
    ]);

    const down: string[] = [];
    await migration.down(runner("postgres", down));
    expect(down).toEqual(['DROP INDEX IF EXISTS "IDX_session_createdAt_id"']);
  });

  it("rebuilds an invalid index left by an interrupted build", async () => {
    const up: string[] = [];
    await new IndexSessionCreatedAt1792060000000().up(runner("postgres", up, { invalid: true }));
    expect(up.slice(2)).toEqual(['DROP INDEX CONCURRENTLY IF EXISTS "IDX_session_createdAt_id"', CREATE]);
  });

  // `migration:run` runs only the application migrations, so on a new database
  // Better Auth has not created its tables yet.
  it("fails with the command that creates the Better Auth tables on PostgreSQL", async () => {
    const up: string[] = [];
    await expect(new IndexSessionCreatedAt1792060000000().up(runner("postgres", up, { session: false })))
      .rejects.toThrow('Better Auth has not created the "session" table yet. Run "bun run --cwd apps/api migrate:all"');
    expect(up).toEqual([SESSION_EXISTS]);
  });

  it("fails with the command that creates the Better Auth tables on SQLite and records nothing", async () => {
    const database = new Database(":memory:");
    try {
      const migrations = [{ timestamp: 1792060000000, migration: new IndexSessionCreatedAt1792060000000() }];
      await expect(runSqliteMigrations(database, migrations)).rejects.toThrow(
        'Better Auth has not created the "session" table yet. Run "bun run --cwd apps/api migrate:all"',
      );
      expect(rows(database, 'SELECT "name" FROM "migrations"')).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("serves the newest-first session page on SQLite and reverts", async () => {
    const database = new Database(":memory:");
    try {
      database.run(`CREATE TABLE "session" (
        "id" text PRIMARY KEY, "userId" text NOT NULL, "token" text NOT NULL,
        "expiresAt" date NOT NULL, "createdAt" date NOT NULL, "updatedAt" date NOT NULL
      )`);
      const migrations = [{ timestamp: 1792060000000, migration: new IndexSessionCreatedAt1792060000000() }];
      await runSqliteMigrations(database, migrations);
      const plan = rows<{ detail: string }>(
        database,
        `EXPLAIN QUERY PLAN SELECT "id" FROM "session" WHERE "expiresAt" > '2026' ORDER BY "createdAt" DESC, "id" DESC LIMIT 16`,
      ).map((row) => row.detail).join("\n");
      expect(plan).toContain("IDX_session_createdAt_id");
      expect(plan).not.toContain("TEMP B-TREE");

      expect(await revertLatestSqliteMigration(database, migrations)).toBe(true);
      expect(rows(database, `SELECT "name" FROM "sqlite_master" WHERE "type" = 'index' AND "name" LIKE 'IDX_%'`))
        .toEqual([]);
    } finally {
      database.close();
    }
  });
});
