import { Database as SqliteDatabase } from "bun:sqlite";
import type { MigrationInterface, QueryRunner } from "typeorm";
import { loadMigrations, migrationSet } from "./migration-files";

export interface SqliteMigrationDefinition {
  timestamp: number;
  migration: MigrationInterface;
}

interface AppliedMigration {
  id: number;
  timestamp: number;
  name: string;
}

async function discoverMigrations(): Promise<SqliteMigrationDefinition[]> {
  return loadMigrations(migrationSet());
}

function queryRunner(database: SqliteDatabase): QueryRunner {
  return {
    connection: { options: { type: "better-sqlite3" } },
    query: (sql: string): Promise<unknown> => Promise.resolve(database.run(sql)),
  } as unknown as QueryRunner;
}

function prepare(database: SqliteDatabase): void {
  database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA foreign_keys = ON");
  database.run("PRAGMA busy_timeout = 5000");
  database.run(`
    CREATE TABLE IF NOT EXISTS "migrations" (
      "id" integer PRIMARY KEY AUTOINCREMENT,
      "timestamp" bigint NOT NULL,
      "name" text NOT NULL UNIQUE
    )
  `);
}

function migrationName(migration: MigrationInterface): string {
  if (typeof migration.name !== "string" || migration.name.length === 0) {
    throw new Error("SQLite migration classes must declare a non-empty name");
  }
  return migration.name;
}

/** Applies every pending migration in timestamp order and returns the names it applied. */
export async function runSqliteMigrations(
  database: SqliteDatabase,
  supplied?: readonly SqliteMigrationDefinition[],
): Promise<string[]> {
  prepare(database);
  const definitions = supplied ? [...supplied] : await discoverMigrations();
  definitions.sort((left, right) => left.timestamp - right.timestamp);
  const applied = new Set(
    database.query<Pick<AppliedMigration, "name">, []>(
      'SELECT "name" FROM "migrations"',
    ).all().map((row) => row.name),
  );
  const runner = queryRunner(database);
  const ran: string[] = [];
  for (const definition of definitions) {
    const name = migrationName(definition.migration);
    if (applied.has(name)) continue;
    database.run("BEGIN IMMEDIATE");
    try {
      await definition.migration.up(runner);
      database.query(
        'INSERT INTO "migrations" ("timestamp", "name") VALUES (?1, ?2)',
      ).run(definition.timestamp, name);
      database.run("COMMIT");
    } catch (error) {
      database.run("ROLLBACK");
      throw error;
    }
    ran.push(name);
  }
  return ran;
}

export async function revertLatestSqliteMigration(
  database: SqliteDatabase,
  supplied?: readonly SqliteMigrationDefinition[],
): Promise<boolean> {
  prepare(database);
  const latest = database.query<AppliedMigration, []>(
    'SELECT "id", "timestamp", "name" FROM "migrations" ORDER BY "id" DESC LIMIT 1',
  ).get();
  if (!latest) return false;
  const definitions = supplied ? [...supplied] : await discoverMigrations();
  const definition = definitions.find((item) => migrationName(item.migration) === latest.name);
  if (!definition) throw new Error(`Cannot find SQLite migration ${latest.name} to revert`);
  const runner = queryRunner(database);
  database.run("BEGIN IMMEDIATE");
  try {
    await definition.migration.down(runner);
    database.query('DELETE FROM "migrations" WHERE "id" = ?1').run(latest.id);
    database.run("COMMIT");
    return true;
  } catch (error) {
    database.run("ROLLBACK");
    throw error;
  }
}
