import { AppException } from "@podosoft/podokit-contracts";
import type { DataSource, DataSourceOptions, QueryRunner } from "typeorm";
import { databaseUnavailable } from "../auth/database-outage";
import { AuthPostgresPool } from "../auth/postgres-pool";
import type { AppEnv } from "../config/env.validation";
import { READINESS, type ServiceKey, type ServiceRegistry } from "../core/services";
import { isDatabaseUnavailable } from "./database";
import {
  assertMigrationsApplied,
  initializeApplicationDataSource,
  SchemaNotCurrentError,
} from "./schema-readiness";

/** Names both the supervised connection and the readiness check of pdmux's own database. */
export const APPLICATION_DATABASE_CHECK = "pdmux-schema";
export const APPLICATION_DATABASE = Symbol("application-database") as ServiceKey<ApplicationDatabase>;

/** `error` as DATABASE_UNAVAILABLE when it means PostgreSQL could not be reached, otherwise unchanged. */
function asDatabaseUnavailable(error: unknown): unknown {
  if (error instanceof AppException || !isDatabaseUnavailable(error)) return error;
  const unavailable = databaseUnavailable();
  unavailable.cause = error;
  return unavailable;
}

const RUNNER_MEMBERS = ["connect", "query"] as const;

/**
 * Every repository, query builder, transaction and migration check reaches
 * PostgreSQL through a query runner, and the API's error envelope only knows
 * PodoKit's error shapes, so a refused or dropped connection would answer 500.
 * Each runner the driver creates rethrows such errors as DATABASE_UNAVAILABLE.
 */
function translateConnectionErrors(dataSource: DataSource): void {
  const driver = dataSource.driver;
  const create = driver.createQueryRunner.bind(driver);
  driver.createQueryRunner = (mode: Parameters<typeof create>[0]): QueryRunner => {
    const runner = create(mode);
    for (const member of RUNNER_MEMBERS) {
      const original: unknown = Reflect.get(runner, member);
      if (typeof original !== "function") continue;
      // An own property, so the runner's internal `this.query(...)` calls pass through it too.
      Reflect.set(runner, member, async (...args: unknown[]): Promise<unknown> => {
        try {
          return await Reflect.apply(original, runner, args);
        } catch (error: unknown) {
          throw asDatabaseUnavailable(error);
        }
      });
    }
    return runner;
  };
}

/**
 * The API's TypeORM pool with the authentication pool's outage rules: a
 * connection that cannot be opened in `DB_CONNECT_TIMEOUT_MS` fails, a query
 * fails after `DB_QUERY_TIMEOUT_MS`, and a connection released while it still
 * waits for a reply is closed instead of handed to the next query. Migrations
 * and the worker keep their own options without these timeouts.
 */
export function applicationDataSourceOptions(options: DataSourceOptions, env: AppEnv): DataSourceOptions {
  if (options.type !== "postgres") return options;
  return {
    ...options,
    driver: { Pool: AuthPostgresPool },
    connectTimeoutMS: env.DB_CONNECT_TIMEOUT_MS,
    extra: { ...options.extra, query_timeout: env.DB_QUERY_TIMEOUT_MS },
  };
}

export interface ApplicationDatabaseHooks {
  /** Work that needs the database. It runs to completion once, after the first connection. */
  start(): Promise<void>;
  /** Stops what `start` began. Runs on shutdown, and only when `start` completed. */
  stop(): Promise<void>;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * pdmux's own TypeORM connection, opened in the background by the service
 * registry's supervisor so the API listens while PostgreSQL is down. Until the
 * first connection has checked the schema and run the start hook, every caller
 * is refused with DATABASE_UNAVAILABLE. pg reopens pooled connections on its own
 * after that, so a later outage needs no new connect.
 */
export class ApplicationDatabase {
  private started = false;
  private stopped = false;
  private attempt?: Promise<void>;
  private refusal?: SchemaNotCurrentError;
  private failure = "The application database has not connected yet";

  constructor(
    readonly dataSource: DataSource,
    private readonly hooks: ApplicationDatabaseHooks,
  ) {
    if (dataSource.options.type === "postgres") translateConnectionErrors(dataSource);
  }

  get ready(): boolean {
    return this.started && !this.stopped;
  }

  /** Set when the latest attempt reached PostgreSQL and found a schema older than this build. */
  get schemaRefusal(): SchemaNotCurrentError | undefined {
    return this.refusal;
  }

  connect(): Promise<void> {
    this.attempt ??= this.open().finally(() => {
      this.attempt = undefined;
    });
    return this.attempt;
  }

  assertReady(): void {
    if (!this.ready) throw databaseUnavailable();
  }

  /** The readiness check: connected, started, and the schema still current. */
  async check(): Promise<void> {
    if (!this.ready) throw new Error(this.failure);
    await assertMigrationsApplied(this.dataSource);
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.attempt?.catch(() => undefined);
    if (this.started) await this.hooks.stop();
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }

  private async open(): Promise<void> {
    if (this.stopped || this.started) return;
    try {
      if (!this.dataSource.isInitialized) await initializeApplicationDataSource(this.dataSource);
      this.refusal = undefined;
      if (this.stopped) return;
      await this.hooks.start();
      this.started = true;
    } catch (error: unknown) {
      if (error instanceof SchemaNotCurrentError) this.refusal = error;
      this.failure = reasonOf(error);
      throw error;
    }
  }
}

/**
 * Connects `database` in the background, reports it as the `pdmux-schema`
 * readiness check, and closes it with the registry. Startup still fails when
 * the first attempt reached a database whose schema is behind this build;
 * later attempts keep retrying, so running the migrations recovers the API
 * without a restart.
 */
export function superviseApplicationDatabase(services: ServiceRegistry, database: ApplicationDatabase): void {
  services.register(APPLICATION_DATABASE, database, () => database.close());
  services.supervise(APPLICATION_DATABASE_CHECK, database);
  services.resolve(READINESS).register(APPLICATION_DATABASE_CHECK, () => database.check());
  services.onStart(() => {
    if (database.schemaRefusal) throw database.schemaRefusal;
  });
}
