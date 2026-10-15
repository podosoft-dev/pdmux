import { describe, expect, it } from "bun:test";
import { Database as SqliteDatabase } from "bun:sqlite";
import type { MigrationInterface, QueryRunner } from "typeorm";
import {
  revertLatestSqliteMigration,
  runSqliteMigrations,
  type SqliteMigrationDefinition,
} from "./sqlite-migrator";

class CreateExample1000 implements MigrationInterface {
  name = "CreateExample1000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE TABLE "example" ("id" text PRIMARY KEY)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "example"');
  }
}

const definitions: readonly SqliteMigrationDefinition[] = [
  { timestamp: 1_000, migration: new CreateExample1000() },
];

describe("SQLite migrator", () => {
  it("runs each migration once and records it atomically", async () => {
    const database = new SqliteDatabase(":memory:");
    try {
      await runSqliteMigrations(database, definitions);
      await runSqliteMigrations(database, definitions);
      expect(database.query<{ count: number }, []>('SELECT count(*) AS "count" FROM "migrations"').get()?.count).toBe(1);
      expect(database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name = 'example'").get()?.name).toBe("example");
    } finally {
      database.close();
    }
  });

  it("reverts the latest applied migration", async () => {
    const database = new SqliteDatabase(":memory:");
    try {
      await runSqliteMigrations(database, definitions);
      await expect(revertLatestSqliteMigration(database, definitions)).resolves.toBe(true);
      expect(database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name = 'example'").get()).toBeNull();
      await expect(revertLatestSqliteMigration(database, definitions)).resolves.toBe(false);
    } finally {
      database.close();
    }
  });
});
