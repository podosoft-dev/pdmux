import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDataSourceOptions } from "./data-source";
import { checkMigrations } from "../../scripts/check-migrations.mjs";

const migrationDirectory = join(__dirname, "../migrations");
const expectedNames = readdirSync(migrationDirectory)
  .filter((file) => /^\d+-.+\.ts$/.test(file))
  .map((file) => {
    const match = /^(\d+)-(.+)\.ts$/.exec(file);
    if (!match) throw new Error(`Invalid migration filename: ${file}`);
    return `${match[2]}${match[1]}`;
  })
  .sort();

describe("[TC-PDHOST-028] bundled migration discovery", () => {
  it("fails the build when a source migration is not registered or a historical file is missing", () => {
    const files = readdirSync(migrationDirectory);
    checkMigrations(files);
    expect(() => checkMigrations([...files, "1999999999999-Unregistered.ts"]))
      .toThrow("every source migration exactly once");
    expect(() => checkMigrations(files.slice(1))).toThrow("every source migration exactly once");
    expect(() => checkMigrations([])).toThrow("every source migration exactly once");
  });
  it("registers every historical migration as a class, never a runtime glob", () => {
    const migrations = createDataSourceOptions({}).migrations;
    expect(Array.isArray(migrations)).toBe(true);
    if (!Array.isArray(migrations)) throw new Error("Expected migration classes");
    expect(migrations.every((migration) => typeof migration === "function")).toBe(true);
    expect(migrations.map((migration) => typeof migration === "function" ? migration.name : migration).sort())
      .toEqual(expectedNames);
    expect(new Set(migrations).size).toBe(migrations.length);
  });

  it("keeps PostgreSQL migrations out of the desktop SQLite provider", () => {
    expect(createDataSourceOptions({ PDMUX_DESKTOP: "1", DATABASE_URL: ":memory:" }).migrations)
      .toEqual([]);
  });

  it("discovers the same migrations from a standalone bundle with no source tree", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pdmux-migration-bundle-"));
    try {
      const result = await Bun.build({
        entrypoints: [join(__dirname, "data-source.ts")],
        outdir: directory,
        naming: "data-source.js",
        target: "bun",
      });
      expect(result.success).toBe(true);
      const child = Bun.spawn([
        process.execPath,
        "--eval",
        `const { dataSourceOptions } = await import(${JSON.stringify(join(directory, "data-source.js"))});
         console.log(JSON.stringify(dataSourceOptions.migrations.map(m => typeof m === "function" ? m.name : m).sort()));`,
      ], {
        cwd: directory,
        env: { NODE_ENV: "production", PATH: process.env.PATH ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual(expectedNames);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
