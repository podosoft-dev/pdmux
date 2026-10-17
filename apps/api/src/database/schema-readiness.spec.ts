import { describe, expect, it } from "bun:test";
import type { DataSource } from "typeorm";
import { ReadinessService } from "../health/readiness.service";
import type { MigrationSet } from "./migration-files";
import { assertMigrationsApplied, initializeApplicationDataSource, SchemaNotCurrentError } from "./schema-readiness";

class FirstMigration1000 {
  name = "FirstMigration1000";
  up(): Promise<void> { return Promise.resolve(); }
  down(): Promise<void> { return Promise.resolve(); }
}

const built: MigrationSet = {
  directory: "dist/migrations",
  compiled: true,
  files: [{ file: "1000-FirstMigration.js", name: "FirstMigration1000" }],
};

function source(pending: boolean): Pick<DataSource, "options" | "migrations" | "showMigrations"> {
  return {
    options: { type: "postgres" },
    migrations: [new FirstMigration1000()],
    showMigrations: (): Promise<boolean> => Promise.resolve(pending),
  };
}

describe("[TC-PDHOST-029] migration startup and readiness gate", () => {
  it("rejects a data source that loaded fewer migrations than the build lists", async () => {
    await expect(assertMigrationsApplied({ ...source(false), migrations: [] }, built))
      .rejects.toThrow("Loaded 0 of the 1 migrations");
    await expect(assertMigrationsApplied(source(false), { ...built, files: [] }))
      .rejects.toThrow("migration list is empty");
  });

  it("rejects an old schema and accepts an already migrated database", async () => {
    await expect(assertMigrationsApplied(source(true), built)).rejects.toThrow("pending migrations");
    await assertMigrationsApplied(source(false), built);
  });

  it("reports a missing migration as down rather than a healthy database connection", async () => {
    const readiness = new ReadinessService();
    readiness.register("pdmux-schema", () => assertMigrationsApplied(source(true), built));
    expect(await readiness.run()).toEqual({ "pdmux-schema": "down" });
  });

  it("closes the database connection when startup is refused", async () => {
    const calls: string[] = [];
    const candidate = {
      ...source(true),
      initialize: (): Promise<void> => { calls.push("initialize"); return Promise.resolve(); },
      destroy: (): Promise<void> => { calls.push("destroy"); return Promise.resolve(); },
    } as unknown as DataSource;
    await expect(initializeApplicationDataSource(candidate)).rejects.toThrow(SchemaNotCurrentError);
    expect(calls).toEqual(["initialize", "destroy"]);
  });

  it("does not run PostgreSQL schema checks on desktop SQLite", async () => {
    await assertMigrationsApplied({
      options: { type: "better-sqlite3", database: ":memory:" },
      migrations: [],
      showMigrations: (): Promise<boolean> => Promise.reject(new Error("Must not query PostgreSQL migrations")),
    });
  });
});
