import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MigrationInterface } from "typeorm";
import {
  assertMigrationsLoaded,
  loadMigrations,
  MIGRATION_LIST,
  migrationPaths,
  migrationSet,
} from "./migration-files";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function apiRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "migration-files-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const migrationSource = (name: string): string =>
  `export class ${name} { name = "${name}"; async up() {} async down() {} }\n`;

const loaded = (...names: string[]): MigrationInterface[] =>
  names.map((name) => ({ name, up: async () => undefined, down: async () => undefined }));

describe("migration files", () => {
  it("lists source migrations in timestamp order outside production", () => {
    const root = apiRoot({
      "src/migrations/1700000000002-Second.ts": migrationSource("Second1700000000002"),
      "src/migrations/1700000000001-First.ts": migrationSource("First1700000000001"),
      "src/migrations/helpers.ts": "export {};\n",
      "dist/migrations/1690000000000-Stale.js": migrationSource("Stale1690000000000"),
    });
    const set = migrationSet({ root, production: false });
    expect(set).toEqual({
      directory: join(root, "src/migrations"),
      compiled: false,
      files: [{ file: "1700000000001-First.ts" }, { file: "1700000000002-Second.ts" }],
    });
    expect(migrationPaths(set)).toEqual([
      join(root, "src/migrations/1700000000001-First.ts"),
      join(root, "src/migrations/1700000000002-Second.ts"),
    ]);
  });

  it("reads the build's list in production", () => {
    const list = [{ file: "1700000000001-First.js", name: "First1700000000001" }];
    const root = apiRoot({
      [`dist/migrations/${MIGRATION_LIST}`]: JSON.stringify(list),
      "dist/migrations/1700000000001-First.js": migrationSource("First1700000000001"),
    });
    expect(migrationSet({ root, production: true })).toEqual({
      directory: join(root, "dist/migrations"),
      compiled: true,
      files: list,
    });
  });

  it("refuses a build output without its list instead of running no migrations", () => {
    const root = apiRoot({ "dist/main.js": "", "dist/migrations/src/migrations/1700000000001-First.js": "" });
    expect(() => migrationSet({ root, production: true })).toThrow(`${MIGRATION_LIST} is missing`);
  });

  it("refuses a list whose files are missing", () => {
    const root = apiRoot({
      [`dist/migrations/${MIGRATION_LIST}`]: JSON.stringify([{ file: "1700000000001-First.js", name: "First1700000000001" }]),
    });
    expect(() => migrationSet({ root, production: true })).toThrow("Compiled migrations are missing");
  });

  it("runs source migrations when production code runs without a build", () => {
    const root = apiRoot({ "src/migrations/1700000000001-First.ts": migrationSource("First1700000000001") });
    expect(migrationSet({ root, production: true })).toMatchObject({ compiled: false, files: [{ file: "1700000000001-First.ts" }] });
  });

  it("fails when a runner loaded fewer migrations than the set holds", () => {
    const root = apiRoot({
      "src/migrations/1700000000001-First.ts": migrationSource("First1700000000001"),
      "src/migrations/1700000000002-Second.ts": migrationSource("Second1700000000002"),
    });
    const set = migrationSet({ root, production: false });
    expect(() => assertMigrationsLoaded([], set)).toThrow("Loaded 0 of the 2 migrations");
    expect(() => assertMigrationsLoaded(loaded("First1700000000001", "Second1700000000002"), set)).not.toThrow();
  });

  it("fails when the build's listed names did not load", () => {
    const set = {
      directory: "dist/migrations",
      compiled: true,
      files: [{ file: "1700000000001-First.js", name: "First1700000000001" }],
    };
    expect(() => assertMigrationsLoaded(loaded("Other1700000000001"), set)).toThrow("did not load: First1700000000001");
  });

  it("loads one migration class from each file", async () => {
    const root = apiRoot({
      "src/migrations/1700000000001-First.ts": migrationSource("First1700000000001"),
      "src/migrations/1700000000002-Two.ts": `${migrationSource("A1700000000002")}${migrationSource("B1700000000002")}`,
    });
    const set = migrationSet({ root, production: false });
    await expect(loadMigrations({ ...set, files: set.files.slice(0, 1) })).resolves.toMatchObject([
      { file: "1700000000001-First.ts", timestamp: 1700000000001, migration: { name: "First1700000000001" } },
    ]);
    await expect(loadMigrations(set)).rejects.toThrow("must export exactly one migration class");
  });
});
