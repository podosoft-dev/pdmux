import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createDataSourceOptions } from "./app-data-source";
import { loadMigrations, migrationName, migrationPaths, migrationSet } from "./migration-files";

const API_ROOT = join(__dirname, "../..");
const sourceFiles = readdirSync(join(API_ROOT, "src/migrations")).filter((file) => /^\d+-.+\.ts$/.test(file)).sort();

describe("[TC-PDHOST-028] migration discovery", () => {
  it("loads every source migration as exactly one migration class", async () => {
    const set = migrationSet({ root: API_ROOT, production: false });
    expect(set.files.map((entry) => entry.file)).toEqual(sourceFiles);
    const loaded = await loadMigrations(set);
    expect(loaded.map(({ file }) => file)).toEqual(sourceFiles);
    expect(loaded.map(({ file, migration }) => {
      const match = /^(\d+)-(.+)\.ts$/.exec(file);
      return match ? `${match[2]}${match[1]}` === migrationName(migration) : false;
    })).toEqual(sourceFiles.map(() => true));
  });

  it("gives the PostgreSQL runtime data source the build's migrations", () => {
    const set = migrationSet({ root: API_ROOT, production: false });
    expect(createDataSourceOptions({}, set).migrations).toEqual(migrationPaths(set));
  });

  it("keeps PostgreSQL migrations out of the desktop SQLite provider", () => {
    expect(createDataSourceOptions({ DATABASE_PROVIDER: "sqlite", DATABASE_URL: ":memory:" }).migrations)
      .toEqual([]);
  });
});
