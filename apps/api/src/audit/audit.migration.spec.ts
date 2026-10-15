import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type { QueryRunner } from "typeorm";
import { revertLatestSqliteMigration, runSqliteMigrations } from "../database/sqlite-migrator";
import { InitAuditLogs1720300000000 } from "../migrations/1720300000000-InitAuditLogs";
import { IndexAuditLogFilters1792000000000 } from "../migrations/1792000000000-IndexAuditLogFilters";

function runner(type: "postgres" | "better-sqlite3", queries: string[]): QueryRunner {
  return {
    connection: { options: { type } },
    query: (sql: string): Promise<unknown[]> => {
      queries.push(sql);
      return Promise.resolve([]);
    },
  } as unknown as QueryRunner;
}

const FILTER_INDEXES = [
  "IDX_audit_logs_action_createdAt",
  "IDX_audit_logs_actorEmail_createdAt",
  "IDX_audit_logs_createdAt_id",
  "IDX_audit_logs_targetLabel_createdAt",
];
const INITIAL_INDEXES = ["IDX_audit_logs_action", "IDX_audit_logs_createdAt"];

// Finalized at once: an open statement keeps SQLite from dropping an index.
function rows<Row>(database: Database, sql: string): Row[] {
  const statement = database.prepare<Row, []>(sql);
  try {
    return statement.all();
  } finally {
    statement.finalize();
  }
}

function indexNames(database: Database): string[] {
  return rows<{ name: string }>(
    database,
    `SELECT "name" FROM "sqlite_master" WHERE "type" = 'index' AND "tbl_name" = 'audit_logs' AND "name" LIKE 'IDX_%'`,
  ).map((row) => row.name).sort();
}

describe("audit log migration", () => {
  it("retains PostgreSQL UUID and JSONB storage", async () => {
    const queries: string[] = [];
    await new InitAuditLogs1720300000000().up(runner("postgres", queries));
    expect(queries[0]).toContain("CREATE EXTENSION");
    expect(queries[1]).toContain("uuid NOT NULL DEFAULT gen_random_uuid()");
    expect(queries[1]).toContain("jsonb");
  });

  it("uses portable SQLite column types and defaults", async () => {
    const queries: string[] = [];
    await new InitAuditLogs1720300000000().up(runner("better-sqlite3", queries));
    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain('"id" text NOT NULL');
    expect(queries[0]).toContain('"metadata" text');
    expect(queries[0]).toContain("DEFAULT CURRENT_TIMESTAMP");
    expect(queries.join("\n")).not.toContain("CREATE EXTENSION");
  });
});

describe("audit filter index migration", () => {
  it("replaces the single-column indexes on PostgreSQL and restores them on revert", async () => {
    const migration = new IndexAuditLogFilters1792000000000();
    const up: string[] = [];
    await migration.up(runner("postgres", up));
    expect(up).toEqual([
      'CREATE INDEX IF NOT EXISTS "IDX_audit_logs_createdAt_id" ON "audit_logs" ("createdAt", "id")',
      'CREATE INDEX IF NOT EXISTS "IDX_audit_logs_action_createdAt" ON "audit_logs" ("action", "createdAt")',
      'CREATE INDEX IF NOT EXISTS "IDX_audit_logs_actorEmail_createdAt" ON "audit_logs" ("actorEmail", "createdAt")',
      'CREATE INDEX IF NOT EXISTS "IDX_audit_logs_targetLabel_createdAt" ON "audit_logs" ("targetLabel", "createdAt")',
      'DROP INDEX IF EXISTS "IDX_audit_logs_action"',
      'DROP INDEX IF EXISTS "IDX_audit_logs_createdAt"',
    ]);
    expect(up.join("\n")).not.toContain("CONCURRENTLY");

    const down: string[] = [];
    await migration.down(runner("postgres", down));
    expect(down).toEqual([
      'CREATE INDEX IF NOT EXISTS "IDX_audit_logs_action" ON "audit_logs" ("action")',
      'CREATE INDEX IF NOT EXISTS "IDX_audit_logs_createdAt" ON "audit_logs" ("createdAt")',
      'DROP INDEX IF EXISTS "IDX_audit_logs_createdAt_id"',
      'DROP INDEX IF EXISTS "IDX_audit_logs_action_createdAt"',
      'DROP INDEX IF EXISTS "IDX_audit_logs_actorEmail_createdAt"',
      'DROP INDEX IF EXISTS "IDX_audit_logs_targetLabel_createdAt"',
    ]);
  });

  it("migrates up and down on SQLite", async () => {
    const database = new Database(":memory:");
    const migrations = [
      { timestamp: 1720300000000, migration: new InitAuditLogs1720300000000() },
      { timestamp: 1792000000000, migration: new IndexAuditLogFilters1792000000000() },
    ];
    try {
      await runSqliteMigrations(database, migrations);
      expect(indexNames(database)).toEqual(FILTER_INDEXES);
      const plan = rows<{ detail: string }>(
        database,
        `EXPLAIN QUERY PLAN SELECT "id" FROM "audit_logs" WHERE "actorEmail" = 'a' ORDER BY "createdAt" DESC LIMIT 5`,
      ).map((row) => row.detail).join("\n");
      expect(plan).toContain("IDX_audit_logs_actorEmail_createdAt");

      expect(await revertLatestSqliteMigration(database, migrations)).toBe(true);
      expect(indexNames(database)).toEqual(INITIAL_INDEXES);

      await runSqliteMigrations(database, migrations);
      expect(indexNames(database)).toEqual(FILTER_INDEXES);
    } finally {
      database.close();
    }
  });
});
