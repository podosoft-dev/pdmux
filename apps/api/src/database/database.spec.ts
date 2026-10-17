import { SQL } from "bun";
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { QueryFailedError } from "typeorm";
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

  it("puts the default SQLite database at SQLITE_PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "podokit-sqlite-"));
    try {
      const path = join(root, "state", "app.sqlite");
      expect(databaseUrl({ ...env, SQLITE_PATH: path }, "sqlite")).toBe(`sqlite://${path}`);
      expect(existsSync(dirname(path))).toBe(true);
      expect(databaseUrl(env, "sqlite")).toBe(`sqlite://${join(process.cwd(), "data/podokit.sqlite")}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    expect(() => validateEnv({ DB_QUERY_TIMEOUT_MS: "0" })).toThrow("DB_QUERY_TIMEOUT_MS");
  });

  it("bounds a query on a server that stopped answering after ten seconds by default", () => {
    expect(env.DB_QUERY_TIMEOUT_MS).toBe(10_000);
    expect(validateEnv({ DB_QUERY_TIMEOUT_MS: "2500" }).DB_QUERY_TIMEOUT_MS).toBe(2_500);
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

  it("recognizes pg pool, connection, and query timeouts, also when wrapped", () => {
    const acquire = new Error("timeout exceeded when trying to connect");
    const connect = new Error("Connection terminated due to connection timeout");
    expect(isDatabaseUnavailable(acquire)).toBe(true);
    expect(isDatabaseUnavailable(connect)).toBe(true);
    expect(isDatabaseUnavailable(new Error("Query read timeout"))).toBe(true);
    expect(isDatabaseUnavailable(new Error("Failed to get session", { cause: acquire }))).toBe(true);
  });

  it("recognizes refused, dropped, and shut-down connections from pg and Bun SQL", () => {
    const socket = (code: string): Error => Object.assign(new Error(`connect ${code}`), { code });
    const server = (code: string): Error => Object.assign(new Error("server error"), { code });
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]) {
      expect(isDatabaseUnavailable(socket(code))).toBe(true);
    }
    expect(isDatabaseUnavailable(new Error("Connection terminated unexpectedly"))).toBe(true);
    for (const code of ["57P01", "57P02", "57P03", "08006", "08P01"]) {
      expect(isDatabaseUnavailable(server(code))).toBe(true);
      expect(
        isDatabaseUnavailable(new SQL.PostgresError("server error", { code: "ERR_POSTGRES_SERVER_ERROR", errno: code })),
      ).toBe(true);
    }
    expect(isDatabaseUnavailable(new Error("Failed to save", { cause: socket("ECONNREFUSED") }))).toBe(true);
  });

  it("recognizes host lookup failures from Bun and Node", () => {
    // Bun reports an unknown host as ENOTFOUND and a lookup timeout as ETIMEOUT;
    // Node reports a lookup it could not complete as EAI_AGAIN.
    for (const code of ["ENOTFOUND", "ETIMEOUT", "EAI_AGAIN"]) {
      expect(isDatabaseUnavailable(Object.assign(new Error(`getaddrinfo ${code} db`), { code }))).toBe(true);
    }
  });

  it("recognizes a pg client that was ended or broke while a query waited", () => {
    for (const message of [
      "Connection terminated",
      "Client was closed and is not queryable",
      "Client has encountered a connection error and is not queryable",
    ]) {
      expect(isDatabaseUnavailable(new Error(message))).toBe(true);
    }
  });

  it("follows the per-address errors of a connection that tried several addresses", () => {
    const refused = (address: string): Error =>
      Object.assign(new Error(`connect ECONNREFUSED ${address}:5432`), { code: "ECONNREFUSED" });
    expect(isDatabaseUnavailable(new AggregateError([refused("::1"), refused("127.0.0.1")]))).toBe(true);
    expect(isDatabaseUnavailable(new AggregateError([new Error("first"), new Error("second")]))).toBe(false);
  });

  it("follows the driver error that TypeORM wraps", () => {
    const failed = (driverError: Error): QueryFailedError => new QueryFailedError("SELECT 1", [], driverError);
    expect(isDatabaseUnavailable(failed(new Error("Connection terminated")))).toBe(true);
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
    expect(isDatabaseUnavailable(failed(new AggregateError([refused])))).toBe(true);
    expect(isDatabaseUnavailable(failed(Object.assign(new Error("duplicate key"), { code: "23505" })))).toBe(false);
  });

  it("stops at an error that wraps itself", () => {
    const loop = new Error("outer");
    loop.cause = new Error("inner", { cause: loop });
    expect(isDatabaseUnavailable(loop)).toBe(false);
  });

  it("leaves query and application errors alone", () => {
    expect(isDatabaseUnavailable(new SQL.PostgresError("syntax error", { code: "ERR_POSTGRES_SYNTAX_ERROR" })))
      .toBe(false);
    expect(
      isDatabaseUnavailable(new SQL.PostgresError("duplicate key", { code: "ERR_POSTGRES_SERVER_ERROR", errno: "23505" })),
    ).toBe(false);
    expect(isDatabaseUnavailable(new Error("timeout"))).toBe(false);
    expect(isDatabaseUnavailable(Object.assign(new Error("duplicate key"), { code: "23505" }))).toBe(false);
    expect(isDatabaseUnavailable(Object.assign(new Error("not found"), { code: "ENOENT" }))).toBe(false);
    expect(isDatabaseUnavailable("ERR_POSTGRES_CONNECTION_TIMEOUT")).toBe(false);
    expect(isDatabaseUnavailable(undefined)).toBe(false);
  });

  it("recognizes a real lookup of a host that does not exist", async () => {
    // .invalid never resolves (RFC 2606). A resolver that does not answer at all
    // fails with ETIMEOUT after about 16 seconds, which is recognized too.
    const error: unknown = await fetch("http://database.invalid/").then(() => undefined, (reason: unknown) => reason);
    expect(isDatabaseUnavailable(error)).toBe(true);
  }, 30_000);

  it("recognizes a real refused connection to localhost", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // localhost may resolve to ::1 and 127.0.0.1; a client that tries both fails
    // with an AggregateError of the two refusals.
    const error = await new Promise<unknown>((resolve) => {
      const socket = connect({ host: "localhost", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(undefined);
      });
      socket.once("error", resolve);
    });
    expect(isDatabaseUnavailable(error)).toBe(true);
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
