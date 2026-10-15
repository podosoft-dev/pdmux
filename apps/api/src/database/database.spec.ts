import { SQL } from "bun";
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateEnv } from "../config/env.validation";
import { PROVIDERS } from "../config/providers";
import {
  Database,
  databaseUrl,
  isDatabaseUnavailable,
  postgresPoolOptions,
  sqliteDatabasePath,
} from "./database";
import type { DatabaseProviderName } from "@podosoft/podokit-runtime";

const env = validateEnv({
  NODE_ENV: "test",
  PORT: 5002,
  POSTGRES_HOST: "localhost",
  POSTGRES_PORT: 5432,
  POSTGRES_USER: "podokit",
  POSTGRES_PASSWORD: "podokit",
  POSTGRES_DB: "podokit",
});

function databaseProvider(): DatabaseProviderName {
  return PROVIDERS.database;
}

interface ProbedSql {
  sql: SQL;
  probes: () => number;
  setAvailable: (available: boolean) => void;
  close: () => Promise<void>;
}

// Counts `SELECT 1` probes against an in-memory database and can simulate an outage.
function probedSql(): ProbedSql {
  const target = new SQL(":memory:", { adapter: "sqlite" });
  let probes = 0;
  let available = true;
  const sql = new Proxy(target, {
    apply(query, thisArg: unknown, args: unknown[]): unknown {
      const [strings] = args;
      if (Array.isArray(strings) && strings.join("").trim() === "SELECT 1") {
        probes += 1;
        if (!available) return Promise.reject(new Error("database unavailable"));
      }
      return Reflect.apply(query, thisArg, args);
    },
  });
  return {
    sql,
    probes: () => probes,
    setAvailable: (value) => {
      available = value;
    },
    close: () => target.close(),
  };
}

describe("database provider", () => {
  it("uses DATABASE_URL as the canonical connection setting", () => {
    const provider = databaseProvider();
    const DATABASE_URL = provider === "sqlite"
      ? "sqlite://:memory:"
      : "postgres://podokit:podokit@localhost:5432/podokit";
    expect(databaseUrl({ ...env, DATABASE_URL })).toBe(DATABASE_URL);
  });

  it("keeps the PostgreSQL fields as a fallback and creates a SQLite default", () => {
    const url = databaseUrl(env);
    const provider = databaseProvider();
    if (provider === "sqlite") expect(url).toMatch(/^sqlite:\/\//);
    else expect(url).toBe("postgres://podokit:podokit@localhost:5432/podokit");
  });

  it("rejects a connection URL for the other database dialect", () => {
    const provider = databaseProvider();
    const DATABASE_URL = provider === "sqlite"
      ? "postgres://podokit:podokit@localhost:5432/podokit"
      : "sqlite://:memory:";
    expect(() => databaseUrl({ ...env, DATABASE_URL })).toThrow("DATABASE_URL must use");
  });

  it("creates the parent directory for an explicit SQLite database", () => {
    const root = mkdtempSync(join(tmpdir(), "podokit-sqlite-"));
    try {
      const path = join(root, "nested", "app.sqlite");
      expect(sqliteDatabasePath(`sqlite://${path}`)).toBe(path);
      expect(existsSync(dirname(path))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Database ping", () => {
  it("queries the database on every ping", async () => {
    const probe = probedSql();
    const database = new Database(env, probe.sql);
    try {
      await database.ping();
      const afterFirstPing = probe.probes();
      await database.ping();
      await database.ping();
      expect(probe.probes()).toBe(afterFirstPing + 2);
    } finally {
      await probe.close();
    }
  });

  it("reports an outage that starts after a successful connect", async () => {
    const probe = probedSql();
    const database = new Database(env, probe.sql);
    try {
      await database.connect();
      probe.setAvailable(false);
      await expect(database.ping()).rejects.toThrow("database unavailable");
      probe.setAvailable(true);
      await expect(database.ping()).resolves.toBeUndefined();
    } finally {
      await probe.close();
    }
  });

  it("retries the connection after a failed attempt", async () => {
    const probe = probedSql();
    const database = new Database(env, probe.sql);
    try {
      probe.setAvailable(false);
      await expect(database.connect()).rejects.toThrow("database unavailable");
      probe.setAvailable(true);
      await expect(database.ping()).resolves.toBeUndefined();
      await expect(database.connect()).resolves.toBeUndefined();
    } finally {
      await probe.close();
    }
  });
});

describe("PostgreSQL pool settings", () => {
  it("bounds connections and converts the millisecond settings to Bun seconds", () => {
    expect(postgresPoolOptions(env)).toEqual({ max: 20, connectionTimeout: 10, idleTimeout: 30 });
    expect(env.DB_AUTH_POOL_MAX).toBe(10);
    expect(
      postgresPoolOptions(validateEnv({ DB_POOL_MAX: "5", DB_CONNECT_TIMEOUT_MS: "2500", DB_IDLE_TIMEOUT_MS: "0" })),
    ).toEqual({ max: 5, connectionTimeout: 2.5, idleTimeout: 0 });
  });

  it("rejects pool settings that would disable the limits", () => {
    expect(() => validateEnv({ DB_POOL_MAX: "0" })).toThrow("DB_POOL_MAX");
    expect(() => validateEnv({ DB_AUTH_POOL_MAX: "-1" })).toThrow("DB_AUTH_POOL_MAX");
    expect(() => validateEnv({ DB_CONNECT_TIMEOUT_MS: "0" })).toThrow("DB_CONNECT_TIMEOUT_MS");
  });
});

describe("isDatabaseUnavailable", () => {
  it("recognizes Bun SQL connection failures", () => {
    for (const code of [
      "ERR_POSTGRES_CONNECTION_TIMEOUT",
      "ERR_POSTGRES_CONNECTION_REFUSED",
      "ERR_POSTGRES_CONNECTION_FAILED",
      "ERR_POSTGRES_CONNECTION_CLOSED",
    ]) {
      expect(isDatabaseUnavailable(new SQL.PostgresError("Connection failed", { code }))).toBe(true);
    }
  });

  it("recognizes pg pool and connection timeouts, also when wrapped", () => {
    const acquire = new Error("timeout exceeded when trying to connect");
    const connect = new Error("Connection terminated due to connection timeout");
    expect(isDatabaseUnavailable(acquire)).toBe(true);
    expect(isDatabaseUnavailable(connect)).toBe(true);
    expect(isDatabaseUnavailable(new Error("Failed to get session", { cause: acquire }))).toBe(true);
  });

  it("leaves query and application errors alone", () => {
    expect(isDatabaseUnavailable(new SQL.PostgresError("syntax error", { code: "ERR_POSTGRES_SYNTAX_ERROR" })))
      .toBe(false);
    expect(
      isDatabaseUnavailable(new SQL.PostgresError("duplicate key", { code: "ERR_POSTGRES_SERVER_ERROR", errno: "23505" })),
    ).toBe(false);
    expect(isDatabaseUnavailable(new Error("timeout"))).toBe(false);
    expect(isDatabaseUnavailable("ERR_POSTGRES_CONNECTION_TIMEOUT")).toBe(false);
    expect(isDatabaseUnavailable(undefined)).toBe(false);
  });

  it("recognizes a real Bun SQL connection timeout", async () => {
    // Accepts the TCP connection and never answers, like an overloaded server.
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const sql = new SQL(`postgres://podokit:podokit@127.0.0.1:${server.port}/podokit`, { connectionTimeout: 0.2 });
    try {
      const error: unknown = await sql`SELECT 1`.then(() => undefined, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(SQL.PostgresError);
      expect(isDatabaseUnavailable(error)).toBe(true);
    } finally {
      await sql.close();
      server.stop(true);
    }
  });
});
