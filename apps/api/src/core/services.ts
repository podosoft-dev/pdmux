import { Elysia } from "elysia";
import pino, { type Logger } from "pino";
import {
  DATABASE as RUNTIME_DATABASE,
  type ServiceKey,
} from "@podosoft/podokit-runtime";
import type { AppEnv } from "../config/env.validation";
import { Database } from "../database/database";
import { migrationSet } from "../database/migration-files";
import { MIGRATIONS_READINESS_CHECK, pendingMigrationsCheck } from "../database/migration-readiness";
import { DATABASE_READINESS_CHECK, ReadinessService } from "../health/readiness.service";
import { Shutdown } from "./shutdown";

export type { ServiceKey } from "@podosoft/podokit-runtime";

/** A dependency that `ServiceRegistry.supervise` keeps connected. */
export interface SupervisedConnection {
  /**
   * Opens whatever is closed and restores what depends on it, such as
   * subscriptions. Rejects while the dependency is unreachable.
   */
  connect(): Promise<void>;
  /** Takes the callback to run whenever an open connection drops. */
  onLost?(listener: (reason: unknown) => void): void;
}

export interface ReconnectPolicy {
  /** Delay before the first retry. Each further failure doubles it. */
  initialDelayMs: number;
  /** Longest delay between two attempts. */
  maxDelayMs: number;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = { initialDelayMs: 250, maxDelayMs: 5_000 };

export interface ConnectionEvents {
  unavailable(name: string, reason: string): void;
  restored(name: string, downtimeMs: number): void;
}

export interface RetryTimer {
  /** Runs `task` once after `delayMs`; the returned function cancels it. */
  after(delayMs: number, task: () => void): () => void;
}

const unrefTimer: RetryTimer = {
  after: (delayMs, task) => {
    const timer = setTimeout(task, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

export interface SupervisorOptions {
  policy?: ReconnectPolicy;
  timer?: RetryTimer;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Connects in the background and keeps the connection open: a failed attempt is
 * retried with capped exponential backoff, and a lost connection is reopened.
 * Events fire when the state changes, not on every attempt.
 */
export class ConnectionSupervisor {
  private up = false;
  private stopped = false;
  private failures = 0;
  private drops = 0;
  private lastDrop: unknown;
  private downSince?: number;
  private cancelRetry?: () => void;
  private firstAttempt?: Promise<void>;
  private readonly policy: ReconnectPolicy;
  private readonly timer: RetryTimer;

  constructor(
    readonly name: string,
    private readonly connection: SupervisedConnection,
    private readonly events: ConnectionEvents,
    options: SupervisorOptions = {},
  ) {
    this.policy = options.policy ?? DEFAULT_RECONNECT_POLICY;
    this.timer = options.timer ?? unrefTimer;
    connection.onLost?.((reason) => this.lost(reason));
  }

  get connected(): boolean {
    return this.up;
  }

  /** Resolves after the first attempt, whether or not it connected. */
  start(): Promise<void> {
    this.firstAttempt ??= this.attempt();
    return this.firstAttempt;
  }

  stop(): void {
    this.stopped = true;
    this.up = false;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
  }

  private lost(reason: unknown): void {
    if (this.stopped) return;
    this.drops += 1;
    this.lastDrop = reason;
    // While an attempt is pending it sees the changed count and tries again.
    if (!this.up) return;
    this.up = false;
    this.retry(reason);
  }

  private async attempt(): Promise<void> {
    this.cancelRetry = undefined;
    if (this.stopped) return;
    const drops = this.drops;
    try {
      await this.connection.connect();
    } catch (error) {
      if (!this.stopped) this.retry(error);
      return;
    }
    if (this.stopped) return;
    // Bun reports a failed reconnect through the same close callback, so a drop
    // during the attempt can mean a part of the connection is closed again.
    if (drops !== this.drops) {
      this.retry(this.lastDrop);
      return;
    }
    this.up = true;
    this.failures = 0;
    if (this.downSince !== undefined) {
      this.events.restored(this.name, Date.now() - this.downSince);
      this.downSince = undefined;
    }
  }

  private retry(reason: unknown): void {
    if (this.downSince === undefined) {
      this.downSince = Date.now();
      this.events.unavailable(this.name, reasonOf(reason));
    }
    const delay = Math.min(
      this.policy.maxDelayMs,
      this.policy.initialDelayMs * 2 ** Math.min(this.failures, 30),
    );
    this.failures += 1;
    this.cancelRetry = this.timer.after(delay, () => void this.attempt());
  }
}

export class ServiceRegistry {
  private readonly values = new Map<symbol, unknown>();
  private readonly starters: Array<() => void | Promise<void>> = [];
  private readonly supervisors: ConnectionSupervisor[] = [];
  private readonly closers: Array<() => void | Promise<void>> = [];
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private frozen = false;

  register<T>(key: ServiceKey<T>, value: T, close?: () => void | Promise<void>): void {
    if (this.frozen) throw new Error("Service registry is frozen");
    this.values.set(key, value);
    if (close) this.closers.push(close);
  }

  override<T>(key: ServiceKey<T>, value: T, close?: () => void | Promise<void>): void {
    if (this.frozen) throw new Error("Service registry is frozen");
    if (!this.values.has(key)) throw new Error("Cannot override an unregistered service");
    this.values.set(key, value);
    if (close) this.closers.push(close);
  }

  resolve<T>(key: ServiceKey<T>): T {
    const value = this.values.get(key);
    if (value === undefined) throw new Error("Required service is not registered");
    return value as T;
  }

  tryResolve<T>(key: ServiceKey<T>): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  /** Runs `start` before the server listens; a rejection fails startup. */
  onStart(start: () => void | Promise<void>): void {
    if (this.frozen) throw new Error("Service registry is frozen");
    this.starters.push(start);
  }

  /**
   * Connects `connection` when the registry starts and keeps it connected.
   * Startup waits only for the first attempt, so the server listens while the
   * dependency is down; register a readiness check that reports it.
   */
  supervise(name: string, connection: SupervisedConnection): void {
    if (this.frozen) throw new Error("Service registry is frozen");
    this.supervisors.push(new ConnectionSupervisor(name, connection, {
      // Resolved on use: a module such as logging may replace the logger.
      unavailable: (dependency, reason) => {
        this.tryResolve(LOGGER)?.warn(
          { dependency, reason },
          "Dependency connection failed; retrying in the background",
        );
      },
      restored: (dependency, downtimeMs) => {
        this.tryResolve(LOGGER)?.info({ dependency, downtimeMs }, "Dependency connection restored");
      },
    }));
  }

  freeze(): void {
    this.frozen = true;
  }

  /**
   * Makes a first connection attempt for every supervised dependency at once,
   * so those that are up are connected before the start hooks run in order.
   */
  start(): Promise<void> {
    this.startPromise ??= (async () => {
      await Promise.all(this.supervisors.map((supervisor) => supervisor.start()));
      for (const start of this.starters) await start();
    })();
    return this.startPromise;
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      for (const supervisor of this.supervisors) supervisor.stop();
      for (const close of [...this.closers].reverse()) await close();
    })();
    return this.closePromise;
  }
}

export type AccessLevel = "public" | "session" | "api-key";

interface AccessRule {
  method: string;
  matcher: RegExp;
  level: AccessLevel;
}

function routeMatcher(pattern: string): RegExp {
  const wildcard = pattern.endsWith("/*");
  const route = wildcard ? pattern.slice(0, -2) : pattern;
  const escaped = route
    .split("/")
    .map((segment) => segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("/");
  return new RegExp(wildcard ? `^${escaped}(?:/.*)?$` : `^${escaped}$`);
}

export class AccessPolicy {
  private readonly rules: AccessRule[] = [];

  register(method: string, pattern: string, level: AccessLevel): void {
    this.rules.push({ method: method.toUpperCase(), matcher: routeMatcher(pattern), level });
  }

  /**
   * The level of the most recently registered matching rule. A HEAD request
   * also matches GET rules, because Elysia answers it with the GET handler.
   */
  resolve(request: Request): AccessLevel {
    const path = new URL(request.url).pathname;
    const method = request.method.toUpperCase();
    const rule = [...this.rules]
      .reverse()
      .find((candidate) =>
        (candidate.method === "*" || candidate.method === method ||
          (method === "HEAD" && candidate.method === "GET")) &&
        candidate.matcher.test(path)
      );
    return rule?.level ?? "session";
  }
}

export interface RequestGuardContext {
  request: Request;
  /** The socket peer. */
  remoteAddress?: string;
  /** The caller's address behind the trusted proxies; see core/client-address.ts. */
  clientAddress?: string;
  setHeader: (name: string, value: string) => void;
}

export type RequestGuard = (context: RequestGuardContext) => void | Promise<void>;

export class RequestGuardRegistry {
  private readonly guards: RequestGuard[] = [];

  register(guard: RequestGuard): void {
    this.guards.push(guard);
  }

  async run(context: RequestGuardContext): Promise<void> {
    for (const guard of this.guards) await guard(context);
  }
}

export interface RequestIdentity {
  userId(request: Request): Promise<string | undefined>;
  isAdmin(request: Request): Promise<boolean>;
  roles(request: Request): Promise<string[]>;
  activeOrganizationId(request: Request): Promise<string | undefined>;
}

/** A session the API resolved while handling a request. */
export interface ResolvedSession {
  /** The session token without its cookie signature. */
  token: string;
  userId: string;
  expiresAt: Date;
}

/**
 * Passes each session the API resolves for a request to the modules that listen,
 * so they can use it without a session lookup of their own. The auth module
 * reports; the rate limiter listens to count a signed-in caller per user.
 */
export class ResolvedSessions {
  private readonly listeners: Array<(session: ResolvedSession) => void> = [];

  listen(listener: (session: ResolvedSession) => void): void {
    this.listeners.push(listener);
  }

  report(session: ResolvedSession): void {
    for (const listener of this.listeners) listener(session);
  }
}

export interface OpenApiContribution {
  document: Record<string, unknown>;
  pathPrefix?: string;
}

export type OpenApiContributor = () => OpenApiContribution | Promise<OpenApiContribution>;

export class OpenApiRegistry {
  private readonly contributors = new Map<string, OpenApiContributor>();

  register(name: string, contributor: OpenApiContributor): void {
    if (this.contributors.has(name)) throw new Error(`OpenAPI contributor already exists: ${name}`);
    this.contributors.set(name, contributor);
  }

  async contributions(): Promise<OpenApiContribution[]> {
    return Promise.all([...this.contributors.values()].map((contributor) => contributor()));
  }
}

export const DATABASE = RUNTIME_DATABASE as ServiceKey<Database>;
export const READINESS = Symbol("readiness") as ServiceKey<ReadinessService>;
export const LOGGER = Symbol("logger") as ServiceKey<Logger>;
export const ACCESS_POLICY = Symbol("access-policy") as ServiceKey<AccessPolicy>;
export const REQUEST_GUARDS = Symbol("request-guards") as ServiceKey<RequestGuardRegistry>;
export const REQUEST_IDENTITY = Symbol("request-identity") as ServiceKey<RequestIdentity>;
export const RESOLVED_SESSIONS = Symbol("resolved-sessions") as ServiceKey<ResolvedSessions>;
export const OPENAPI = Symbol("openapi") as ServiceKey<OpenApiRegistry>;
/** Ends streams and WebSockets when the API shuts down; see core/shutdown.ts. */
export const SHUTDOWN = Symbol("shutdown") as ServiceKey<Shutdown>;

export interface AppContext {
  env: AppEnv;
  services: ServiceRegistry;
  database: Database;
  readiness: ReadinessService;
  logger: Logger;
  accessPolicy: AccessPolicy;
  requestGuards: RequestGuardRegistry;
  openapi: OpenApiRegistry;
  shutdown: Shutdown;
}

export type ElysiaPlugin = Parameters<Elysia["use"]>[0];
export type AppPlugin = (context: AppContext) => ElysiaPlugin;

export interface PodokitModule {
  name: string;
  configure?: (env: AppEnv, services: ServiceRegistry) => void;
  plugin?: AppPlugin;
}

export function createCoreServices(env: AppEnv): ServiceRegistry {
  const services = new ServiceRegistry();
  const database = new Database(env);
  const readiness = new ReadinessService({
    timeoutMs: env.READINESS_CHECK_TIMEOUT_MS,
    cacheMs: env.READINESS_CACHE_MS,
    // Resolved on use: a module such as logging may replace the logger after this point.
    onCheckFailure: (check, reason) => {
      services.resolve(LOGGER).warn({ check, reason }, "Readiness check failed");
    },
  });
  const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
  const accessPolicy = new AccessPolicy();
  const requestGuards = new RequestGuardRegistry();
  const openapiRegistry = new OpenApiRegistry();
  accessPolicy.register("*", "/health", "public");
  accessPolicy.register("*", "/health/*", "public");
  accessPolicy.register("*", "/api-docs", "public");
  accessPolicy.register("*", "/api-docs/*", "public");
  accessPolicy.register("*", "/api-docs-json", "public");
  accessPolicy.register("*", "/api-docs-elysia-json", "public");
  services.register(DATABASE, database, () => database.close());
  services.supervise(DATABASE_READINESS_CHECK, {
    connect: () => services.resolve(DATABASE).connect(),
    onLost: (listener) => database.onLost(listener),
  });
  services.register(READINESS, readiness);
  readiness.register(DATABASE_READINESS_CHECK, () => services.resolve(DATABASE).ping());
  if (env.NODE_ENV === "production") {
    // Throws when the build output lacks its migration list, so the API does not
    // start without knowing which migrations its schema needs.
    const migrations = migrationSet({ production: true });
    if (migrations.compiled) {
      readiness.register(
        MIGRATIONS_READINESS_CHECK,
        pendingMigrationsCheck(() => services.resolve(DATABASE).sql, migrations),
      );
    }
  }
  services.register(LOGGER, logger);
  services.register(ACCESS_POLICY, accessPolicy);
  services.register(REQUEST_GUARDS, requestGuards);
  services.register(REQUEST_IDENTITY, {
    userId: async () => undefined,
    isAdmin: async () => false,
    roles: async () => [],
    activeOrganizationId: async () => undefined,
  });
  services.register(RESOLVED_SESSIONS, new ResolvedSessions());
  services.register(OPENAPI, openapiRegistry);
  services.register(SHUTDOWN, new Shutdown((error) => {
    services.resolve(LOGGER).warn({ reason: reasonOf(error) }, "Close a connection at shutdown failed");
  }));
  return services;
}

export function appContext(env: AppEnv, services: ServiceRegistry): AppContext {
  return {
    env,
    services,
    database: services.resolve(DATABASE),
    readiness: services.resolve(READINESS),
    logger: services.resolve(LOGGER),
    accessPolicy: services.resolve(ACCESS_POLICY),
    requestGuards: services.resolve(REQUEST_GUARDS),
    openapi: services.resolve(OPENAPI),
    shutdown: services.resolve(SHUTDOWN),
  };
}
