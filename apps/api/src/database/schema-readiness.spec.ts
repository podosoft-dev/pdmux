import { describe, expect, it } from "bun:test";
import type { DataSource } from "typeorm";
import { ReadinessService } from "../health/readiness.service";
import { POSTGRES_MIGRATIONS } from "./migrations";
import { assertMigrationsApplied, initializeApplicationDataSource } from "./schema-readiness";

function source(pending: boolean): Pick<DataSource, "options" | "migrations" | "showMigrations"> {
  return {
    options: { type: "postgres" },
    migrations: POSTGRES_MIGRATIONS.map((Migration) => new Migration()),
    showMigrations: (): Promise<boolean> => Promise.resolve(pending),
  };
}

describe("[TC-PDHOST-029] migration startup and readiness gate", () => {
  it("rejects an empty registry even when TypeORM says there is nothing pending", async () => {
    await expect(assertMigrationsApplied({ ...source(false), migrations: [] }))
      .rejects.toThrow("registry is incomplete");
  });

  it("rejects an old schema and accepts an already migrated database", async () => {
    await expect(assertMigrationsApplied(source(true))).rejects.toThrow("pending migrations");
    await assertMigrationsApplied(source(false));
  });

  it("reports a missing migration as down rather than a healthy database connection", async () => {
    const readiness = new ReadinessService();
    readiness.register("pdmux-schema", () => assertMigrationsApplied(source(true)));
    expect(await readiness.run()).toEqual({ "pdmux-schema": "down" });
  });

  it("closes the database connection when startup is refused", async () => {
    const calls: string[] = [];
    const candidate = {
      ...source(true),
      initialize: (): Promise<void> => { calls.push("initialize"); return Promise.resolve(); },
      destroy: (): Promise<void> => { calls.push("destroy"); return Promise.resolve(); },
    } as unknown as DataSource;
    await expect(initializeApplicationDataSource(candidate)).rejects.toThrow("pending migrations");
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
