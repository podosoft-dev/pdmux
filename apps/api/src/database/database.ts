import { SQL } from "bun";
import type { DatabaseProviderName } from "@podosoft/podokit-runtime";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AppEnv } from "../config/env.validation";
import { PROVIDERS } from "../config/providers";
import { answersOnNewConnection, PoolGuard } from "./pool-guard";

function isSqliteUrl(url: string): boolean {
  return url === ":memory:" || /^(?:sqlite|file):/.test(url);
}

function selectedDatabaseProvider(): DatabaseProviderName {
  return PROVIDERS.database;
}

export function databaseUrl(
  env: AppEnv,
  provider: DatabaseProviderName = selectedDatabaseProvider(),
): string {
  if (env.DATABASE_URL) {
    if (provider === "sqlite" && !isSqliteUrl(env.DATABASE_URL)) {
      throw new Error("DATABASE_URL must use sqlite:, file:, or :memory: for the SQLite provider");
    }
    if (provider === "postgres" && isSqliteUrl(env.DATABASE_URL)) {
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
  mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  return path;
}

export interface PostgresPoolOptions {
  max: number;
  connectionTimeout: number;
  idleTimeout: number;
}

/** Bun SQL takes these timeouts in seconds; the environment sets milliseconds. */
export function postgresPoolOptions(env: AppEnv): PostgresPoolOptions {
  return {
    max: env.DB_POOL_MAX,
    connectionTimeout: env.DB_CONNECT_TIMEOUT_MS / 1000,
    idleTimeout: env.DB_IDLE_TIMEOUT_MS / 1000,
  };
}

// Bun SQL and pg report a database that cannot be reached, a connection that
// could not be opened or taken from a full pool in time, or a query the server
// did not answer in time, with these shapes.
const UNAVAILABLE_SQL_CODES = new Set([
  "ERR_POSTGRES_CONNECTION_TIMEOUT",
  "ERR_POSTGRES_CONNECTION_REFUSED",
  "ERR_POSTGRES_CONNECTION_FAILED",
  "ERR_POSTGRES_CONNECTION_CLOSED",
]);
const UNAVAILABLE_PG_MESSAGES = new Set([
  "timeout exceeded when trying to connect",
  "Connection terminated due to connection timeout",
  "Query read timeout",
]);

/** Whether an error, or one it wraps, means the database is unavailable rather than the request being wrong. */
export function isDatabaseUnavailable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof SQL.PostgresError && UNAVAILABLE_SQL_CODES.has(current.code)) return true;
    if (UNAVAILABLE_PG_MESSAGES.has(current.message)) return true;
    current = current.cause;
  }
  return false;
}

export class Database {
  readonly provider: DatabaseProviderName = selectedDatabaseProvider();
  readonly sql: SQL;
  private readonly guard?: PoolGuard;
  private ready?: Promise<void>;

  constructor(env: AppEnv, sql?: SQL) {
    if (sql) {
      this.sql = sql;
      return;
    }
    const url = databaseUrl(env);
    if (this.provider === "sqlite") {
      this.sql = new SQL(url, { adapter: "sqlite", create: true, readwrite: true, strict: true });
      return;
    }
    this.guard = new PoolGuard(() => new SQL(url, postgresPoolOptions(env)), {
      stallTimeoutMs: env.DB_QUERY_TIMEOUT_MS,
      serverAnswers: () => answersOnNewConnection(url, env.READINESS_CHECK_TIMEOUT_MS),
    });
    // The supervisor's next connect() then checks the new pool.
    this.guard.onLost(() => {
      this.ready = undefined;
    });
    this.sql = this.guard.sql;
  }

  /** Takes the callback to run when the pool is replaced because PostgreSQL stopped answering. */
  onLost(listener: (reason: unknown) => void): void {
    this.guard?.onLost(listener);
  }

  connect(): Promise<void> {
    if (!this.ready) {
      const attempt = this.initialize();
      this.ready = attempt;
      // Forget a failed start so the next call retries instead of replaying the failure.
      void attempt.catch(() => {
        if (this.ready === attempt) this.ready = undefined;
      });
    }
    return this.ready;
  }

  async ping(): Promise<void> {
    await this.connect();
    await this.sql`SELECT 1`;
  }

  async close(): Promise<void> {
    await this.sql.close();
  }

  private async initialize(): Promise<void> {
    if (this.provider === "sqlite") {
      await this.sql`PRAGMA journal_mode = WAL`;
      await this.sql`PRAGMA foreign_keys = ON`;
      await this.sql`PRAGMA busy_timeout = 5000`;
    }
    await this.sql`SELECT 1`;
  }
}
