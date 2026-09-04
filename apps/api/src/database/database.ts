import { SQL } from "bun";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AppEnv } from "../config/env.validation";
import { runtimeProviders, type DatabaseProvider } from "../runtime/providers";

export function databaseUrl(
  env: AppEnv,
  provider: DatabaseProvider = runtimeProviders(process.env).database,
): string {
  if (env.DATABASE_URL) {
    const sqlite = env.DATABASE_URL === ":memory:" || /^(?:sqlite|file):/.test(env.DATABASE_URL);
    if (provider === "sqlite" && !sqlite) {
      throw new Error("DATABASE_URL must use sqlite:, file:, or :memory: for the SQLite provider");
    }
    if (provider === "postgres" && sqlite) {
      throw new Error("DATABASE_URL must use postgres: for the PostgreSQL provider");
    }
    return env.DATABASE_URL;
  }
  if (provider === "sqlite") {
    const path = resolve(process.env.PDMUX_DATA_DIR ?? "./data", "pdmux.sqlite");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    return `sqlite://${path}`;
  }
  const username = encodeURIComponent(env.POSTGRES_USER);
  const password = encodeURIComponent(env.POSTGRES_PASSWORD);
  const database = encodeURIComponent(env.POSTGRES_DB);
  return `postgres://${username}:${password}@${env.POSTGRES_HOST}:${env.POSTGRES_PORT}/${database}`;
}

export function sqliteDatabasePath(url: string): string {
  if (url === ":memory:" || url === "sqlite://:memory:") return ":memory:";
  const path = url.startsWith("sqlite://")
    ? url.slice("sqlite://".length)
    : url.startsWith("file:")
      ? decodeURIComponent(new URL(url).pathname)
      : undefined;
  if (!path) throw new Error("SQLite database URL must use sqlite:, file:, or :memory:");
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
  return resolved;
}

export class Database {
  readonly provider: DatabaseProvider;
  readonly sql: SQL;
  private ready?: Promise<void>;

  constructor(env: AppEnv) {
    this.provider = runtimeProviders(process.env).database;
    const url = databaseUrl(env);
    this.sql = this.provider === "sqlite"
      ? new SQL(url, { adapter: "sqlite", create: true, readwrite: true, strict: true })
      : new SQL(url, { max: 20 });
  }

  connect(): Promise<void> {
    this.ready ??= (async () => {
      if (this.provider === "sqlite") {
        await this.sql`PRAGMA journal_mode = WAL`;
        await this.sql`PRAGMA foreign_keys = ON`;
        await this.sql`PRAGMA busy_timeout = 5000`;
      }
      await this.sql`SELECT 1`;
    })();
    return this.ready;
  }

  async ping(): Promise<void> {
    await this.connect();
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}
