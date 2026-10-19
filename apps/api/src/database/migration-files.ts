import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { MigrationInterface } from "typeorm";

/** The list `scripts/build.mjs` writes next to the compiled migrations. */
export const MIGRATION_LIST = "migrations.json";

const SOURCE_FILE = /^\d+-.+\.ts$/;

export interface MigrationFile {
  file: string;
  /** The migration's name, recorded by the build; unknown for source files until loaded. */
  name?: string;
}

export interface MigrationSet {
  directory: string;
  /** True for the build output, which lists its migrations in `migrations.json`. */
  compiled: boolean;
  /** In timestamp order. */
  files: MigrationFile[];
}

export interface MigrationSetOptions {
  /** The API directory. Defaults to the working directory. */
  root?: string;
  /** Reads the build output. Defaults to NODE_ENV=production. */
  production?: boolean;
}

function readList(path: string): MigrationFile[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry: unknown) =>
      typeof entry === "object" && entry !== null &&
      typeof (entry as Record<string, unknown>).file === "string" &&
      typeof (entry as Record<string, unknown>).name === "string"
    )
  ) {
    throw new Error(`${path} must list { file, name } entries; rebuild the API`);
  }
  return parsed as MigrationFile[];
}

/**
 * The migrations this process runs. In production that is the build output's
 * list; a build output without its list fails instead of running none.
 * Otherwise it is every `<timestamp>-<name>.ts` file in `src/migrations`.
 */
export function migrationSet(options: MigrationSetOptions = {}): MigrationSet {
  const root = options.root ?? process.cwd();
  const production = options.production ?? process.env.NODE_ENV === "production";
  const compiled = join(root, "dist", "migrations");
  const source = join(root, "src", "migrations");
  if (production && existsSync(join(root, "dist"))) {
    const list = join(compiled, MIGRATION_LIST);
    if (!existsSync(list)) {
      throw new Error(`${list} is missing; build the API with scripts/build.mjs before running it`);
    }
    const files = readList(list);
    const missing = files.filter((entry) => !existsSync(join(compiled, entry.file)));
    if (missing.length > 0) {
      throw new Error(`Compiled migrations are missing from ${compiled}: ${missing.map((entry) => entry.file).join(", ")}`);
    }
    return { directory: compiled, compiled: true, files };
  }
  const files = existsSync(source)
    ? readdirSync(source).filter((file) => SOURCE_FILE.test(file)).sort().map((file) => ({ file }))
    : [];
  return { directory: source, compiled: false, files };
}

export function migrationPaths(set: MigrationSet): string[] {
  return set.files.map((entry) => join(set.directory, entry.file));
}

type MigrationConstructor = new () => MigrationInterface;

function isMigration(value: unknown): value is MigrationConstructor {
  if (typeof value !== "function") return false;
  const prototype = (value as { prototype?: unknown }).prototype;
  if (!prototype || typeof prototype !== "object") return false;
  const record = prototype as Record<string, unknown>;
  return typeof record.up === "function" && typeof record.down === "function";
}

/** TypeORM's name for a migration: its `name` property, else its class name. */
export function migrationName(migration: MigrationInterface): string {
  return migration.name || migration.constructor.name;
}

export interface LoadedMigration {
  file: string;
  timestamp: number;
  migration: MigrationInterface;
}

/** Imports every file of the set; each must export exactly one migration class. */
export async function loadMigrations(set: MigrationSet): Promise<LoadedMigration[]> {
  const loaded: LoadedMigration[] = [];
  for (const entry of set.files) {
    const module = await import(pathToFileURL(join(set.directory, entry.file)).href) as Record<string, unknown>;
    const constructors = Object.values(module).filter(isMigration);
    const Constructor = constructors[0];
    if (constructors.length !== 1 || !Constructor) {
      throw new Error(`Migration ${entry.file} must export exactly one migration class`);
    }
    const timestamp = Number(entry.file.slice(0, entry.file.indexOf("-")));
    if (!Number.isSafeInteger(timestamp)) throw new Error(`Migration ${entry.file} has an invalid timestamp`);
    loaded.push({ file: entry.file, timestamp, migration: new Constructor() });
  }
  return loaded;
}

/**
 * Fails unless the migrations a runner loaded are the set: TypeORM loads
 * nothing, without an error, from a path that matches no file.
 */
export function assertMigrationsLoaded(loaded: readonly MigrationInterface[], set: MigrationSet): void {
  if (loaded.length !== set.files.length) {
    throw new Error(
      `Loaded ${loaded.length} of the ${set.files.length} migrations in ${set.directory}; ` +
        "each migration file must export exactly one migration class",
    );
  }
  if (!set.compiled) return;
  const names = new Set(loaded.map(migrationName));
  const absent = set.files.filter((entry) => entry.name && !names.has(entry.name));
  if (absent.length > 0) {
    throw new Error(`Migrations listed in ${MIGRATION_LIST} did not load: ${absent.map((entry) => entry.name).join(", ")}`);
  }
}

/** Names the migrations a run applied, so deployment and development logs show them. */
export function reportApplied(names: readonly string[]): void {
  if (names.length > 0) process.stdout.write(`Applied ${names.length} migrations: ${names.join(", ")}\n`);
}
