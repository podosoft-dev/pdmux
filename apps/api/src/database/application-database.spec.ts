import { describe, expect, it, mock, type Mock } from "bun:test";
import { AppException } from "@podosoft/podokit-contracts";
import { DataSource, QueryFailedError, type QueryRunner } from "typeorm";
import { AuthPostgresPool } from "../auth/postgres-pool";
import { validateEnv } from "../config/env.validation";
import { READINESS, ServiceRegistry } from "../core/services";
import { ReadinessService } from "../health/readiness.service";
import {
  APPLICATION_DATABASE_CHECK,
  ApplicationDatabase,
  applicationDataSourceOptions,
  isDatabaseConnectionError,
  superviseApplicationDatabase,
} from "./application-database";
import { POSTGRES_MIGRATIONS } from "./migrations";

function refused(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
}

interface FakeDatabase {
  dataSource: DataSource;
  state: { reachable: boolean; pending: boolean; initialized: boolean; destroyed: number; initializing?: Promise<void> };
}

/** A PostgreSQL DataSource whose server is reachable or not, and whose schema is current or not. */
function fakeDataSource(reachable: boolean): FakeDatabase {
  const state: FakeDatabase["state"] = { reachable, pending: false, initialized: false, destroyed: 0 };
  const dataSource = {
    options: { type: "postgres" },
    migrations: POSTGRES_MIGRATIONS.map((Migration) => new Migration()),
    driver: { createQueryRunner: (): QueryRunner => ({}) as QueryRunner },
    get isInitialized(): boolean {
      return state.initialized;
    },
    async initialize(): Promise<void> {
      await state.initializing;
      if (!state.reachable) throw refused();
      state.initialized = true;
    },
    async destroy(): Promise<void> {
      state.initialized = false;
      state.destroyed += 1;
    },
    async showMigrations(): Promise<boolean> {
      if (!state.reachable) throw refused();
      return state.pending;
    },
  } as unknown as DataSource;
  return { dataSource, state };
}

function hooks(): { start: Mock<() => Promise<void>>; stop: Mock<() => Promise<void>> } {
  return { start: mock(async () => undefined), stop: mock(async () => undefined) };
}

function registry(): { services: ServiceRegistry; readiness: ReadinessService } {
  const services = new ServiceRegistry();
  const readiness = new ReadinessService({ cacheMs: 0 });
  services.register(READINESS, readiness);
  return { services, readiness };
}

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition");
    await Bun.sleep(10);
  }
}

describe("[TC-PDHOST-032] pdmux database connects in the background", () => {
  it("lets the API start while PostgreSQL refuses connections, then connects without a restart", async () => {
    const { dataSource, state } = fakeDataSource(false);
    const lifecycle = hooks();
    const database = new ApplicationDatabase(dataSource, lifecycle);
    const { services, readiness } = registry();
    superviseApplicationDatabase(services, database);
    services.freeze();

    await services.start();

    expect(database.ready).toBe(false);
    expect(lifecycle.start).not.toHaveBeenCalled();
    expect(await readiness.run()).toEqual({ [APPLICATION_DATABASE_CHECK]: "down" });
    expect(() => database.assertReady()).toThrow(AppException);
    try {
      database.assertReady();
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: "DATABASE_UNAVAILABLE", statusCode: 503 });
    }

    state.reachable = true;
    await until(() => database.ready);
    expect(lifecycle.start).toHaveBeenCalledTimes(1);
    expect(await readiness.run()).toEqual({ [APPLICATION_DATABASE_CHECK]: "up" });
    expect(() => database.assertReady()).not.toThrow();

    await services.close();
    expect(lifecycle.stop).toHaveBeenCalledTimes(1);
    expect(state.destroyed).toBe(1);
    expect(database.ready).toBe(false);
  });

  it("reports the reason the database is not ready on the readiness check", async () => {
    const { dataSource } = fakeDataSource(false);
    const database = new ApplicationDatabase(dataSource, hooks());
    await expect(database.connect()).rejects.toThrow("ECONNREFUSED");
    await expect(database.check()).rejects.toThrow("connect ECONNREFUSED 127.0.0.1:5432");
  });

  it("runs the start hook to completion once, retrying it after a failure", async () => {
    const { dataSource, state } = fakeDataSource(true);
    const start = mock(async (): Promise<void> => {
      if (start.mock.calls.length === 1) throw refused();
    });
    const database = new ApplicationDatabase(dataSource, { start, stop: mock(async () => undefined) });

    await expect(database.connect()).rejects.toThrow("ECONNREFUSED");
    expect(database.ready).toBe(false);
    expect(state.initialized).toBe(true);

    await database.connect();
    await database.connect();
    expect(database.ready).toBe(true);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("still refuses to start against a schema that is behind, and recovers from a later one without a restart", async () => {
    const behind = fakeDataSource(true);
    behind.state.pending = true;
    const refusedStart = registry();
    const refusedDatabase = new ApplicationDatabase(behind.dataSource, hooks());
    superviseApplicationDatabase(refusedStart.services, refusedDatabase);
    refusedStart.services.freeze();
    await expect(refusedStart.services.start()).rejects.toThrow("pending migrations");
    expect(behind.state.initialized).toBe(false);
    await refusedStart.services.close();

    const later = fakeDataSource(false);
    const lifecycle = hooks();
    const database = new ApplicationDatabase(later.dataSource, lifecycle);
    const { services, readiness } = registry();
    superviseApplicationDatabase(services, database);
    services.freeze();
    await services.start();

    later.state.reachable = true;
    later.state.pending = true;
    await until(() => database.schemaRefusal !== undefined);
    expect(database.ready).toBe(false);
    expect(lifecycle.start).not.toHaveBeenCalled();
    expect(await readiness.run()).toEqual({ [APPLICATION_DATABASE_CHECK]: "down" });

    later.state.pending = false;
    await until(() => database.ready);
    expect(lifecycle.start).toHaveBeenCalledTimes(1);
    await services.close();
  });

  it("waits for an attempt in progress on shutdown and starts nothing after it", async () => {
    const { dataSource, state } = fakeDataSource(true);
    let release = (): void => undefined;
    state.initializing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lifecycle = hooks();
    const database = new ApplicationDatabase(dataSource, lifecycle);

    const attempt = database.connect();
    const closed = database.close();
    release();
    await attempt;
    await closed;

    expect(lifecycle.start).not.toHaveBeenCalled();
    expect(lifecycle.stop).not.toHaveBeenCalled();
    expect(state.destroyed).toBe(1);
    expect(database.ready).toBe(false);
    await database.connect();
    expect(lifecycle.start).not.toHaveBeenCalled();
  });
});

describe("[TC-PDHOST-033] pdmux database outages answer DATABASE_UNAVAILABLE", () => {
  it("tells a lost or refused connection apart from a query the database rejected", () => {
    const pgError = (message: string, code?: string): Error => Object.assign(new Error(message), code ? { code } : {});
    const unavailable = [
      refused(),
      pgError("read ECONNRESET", "ECONNRESET"),
      pgError("terminating connection due to administrator command", "57P01"),
      pgError("the database system is starting up", "57P03"),
      pgError("connection failure", "08006"),
      new Error("timeout exceeded when trying to connect"),
      new QueryFailedError("SELECT 1", [], new Error("Connection terminated unexpectedly")),
      new QueryFailedError("SELECT 1", [], new Error("Query read timeout")),
      new Error("outer", { cause: refused() }),
      // Beyond PodoKit's helper: a host name that stops resolving, as Bun reports it,
      // and a pg client that ended or broke while a transaction still held it.
      pgError("getaddrinfo ENOTFOUND postgres", "ENOTFOUND"),
      pgError("getaddrinfo ETIMEOUT postgres", "ETIMEOUT"),
      new QueryFailedError("COMMIT", [], new Error("Connection terminated")),
      new Error("Client has encountered a connection error and is not queryable"),
      new Error("outer", { cause: new Error("Client was closed and is not queryable") }),
    ];
    const rejected = [
      new QueryFailedError("INSERT", [], pgError("duplicate key value violates unique constraint", "23505")),
      new QueryFailedError("SELECT", [], pgError("relation \"hosts\" does not exist", "42P01")),
      new AppException("HOST_NOT_FOUND", "Host not found", 404),
      new Error("boom"),
      "not an error",
    ];
    for (const error of unavailable) expect(isDatabaseConnectionError(error)).toBe(true);
    for (const error of rejected) expect(isDatabaseConnectionError(error)).toBe(false);
  });

  it("rethrows a lost connection from every query runner as DATABASE_UNAVAILABLE", async () => {
    let failure: unknown = refused();
    class Runner {
      async query(_sql: string): Promise<unknown> {
        throw failure;
      }
      async startTransaction(): Promise<void> {
        await this.query("START TRANSACTION");
      }
    }
    const { dataSource } = fakeDataSource(true);
    Reflect.set(dataSource, "driver", { createQueryRunner: (): QueryRunner => new Runner() as unknown as QueryRunner });
    new ApplicationDatabase(dataSource, hooks());
    const runner = dataSource.driver.createQueryRunner("master");

    const original = failure;
    await expect(runner.query("SELECT 1")).rejects.toMatchObject({
      code: "DATABASE_UNAVAILABLE",
      statusCode: 503,
      cause: original,
    });
    await expect(runner.startTransaction()).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });

    failure = new QueryFailedError("INSERT", [], Object.assign(new Error("duplicate key"), { code: "23505" }));
    await expect(runner.query("INSERT")).rejects.toBe(failure);
  });

  it("translates a refused connection on TypeORM's own PostgreSQL query runner", async () => {
    const env = validateEnv({ DB_CONNECT_TIMEOUT_MS: "2000" });
    const dataSource = new DataSource(applicationDataSourceOptions(
      { type: "postgres", host: "127.0.0.1", port: 1, username: "pdmux", password: "pdmux", database: "pdmux" },
      env,
    ));
    new ApplicationDatabase(dataSource, hooks());
    // The pool TypeORM would have opened during initialize, aimed at a port nothing listens on.
    const pool = new AuthPostgresPool({ host: "127.0.0.1", port: 1, connectionTimeoutMillis: 2_000 });
    Reflect.set(dataSource.driver, "master", pool);
    try {
      const runner = dataSource.driver.createQueryRunner("master");
      await expect(runner.query("SELECT 1")).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE", statusCode: 503 });
      await expect(dataSource.driver.createQueryRunner("master").startTransaction())
        .rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });
    } finally {
      await pool.end();
    }
  });

  it("bounds the runtime PostgreSQL pool and discards a connection still waiting for a reply", () => {
    const env = validateEnv({ DB_CONNECT_TIMEOUT_MS: "1500", DB_QUERY_TIMEOUT_MS: "2500" });
    const options = applicationDataSourceOptions({ type: "postgres", extra: { max: 4 } }, env);
    expect(options).toMatchObject({
      driver: { Pool: AuthPostgresPool },
      connectTimeoutMS: 1500,
      extra: { max: 4, query_timeout: 2500 },
    });
    const sqlite = { type: "better-sqlite3", database: ":memory:" } as const;
    expect(applicationDataSourceOptions(sqlite, env)).toBe(sqlite);
  });
});
