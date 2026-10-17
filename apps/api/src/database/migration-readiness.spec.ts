import { describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { pendingMigrationsCheck } from "./migration-readiness";

const set = {
  directory: "dist/migrations",
  compiled: true,
  files: [
    { file: "1700000000001-First.js", name: "First1700000000001" },
    { file: "1700000000002-Second.js", name: "Second1700000000002" },
  ],
};

describe("pending migrations readiness", () => {
  it("is down until every listed migration is applied, then stops querying", async () => {
    const sql = new SQL(":memory:");
    try {
      const check = pendingMigrationsCheck(() => sql, set);
      await expect(check()).rejects.toThrow();
      await sql`CREATE TABLE "migrations" ("id" integer PRIMARY KEY, "timestamp" bigint, "name" text)`;
      await sql`INSERT INTO "migrations" ("timestamp", "name") VALUES (1700000000001, 'First1700000000001')`;
      await expect(check()).rejects.toThrow("1 migrations are pending; run migrate:all: Second1700000000002");
      await sql`INSERT INTO "migrations" ("timestamp", "name") VALUES (1700000000002, 'Second1700000000002')`;
      await expect(check()).resolves.toBeUndefined();
      await sql`DROP TABLE "migrations"`;
      await expect(check()).resolves.toBeUndefined();
    } finally {
      await sql.close();
    }
  });

  it("is up without a query when the build has no migrations", async () => {
    const check = pendingMigrationsCheck(() => { throw new Error("no database"); }, { ...set, files: [] });
    await expect(check()).resolves.toBeUndefined();
  });
});
