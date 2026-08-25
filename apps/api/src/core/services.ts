import { Elysia } from "elysia";
import pino, { type Logger } from "pino";
import type { AppEnv } from "../config/env.validation";
import { Database } from "../database/database";
import { ReadinessService } from "../health/readiness.service";

export type ServiceKey<T> = symbol & { readonly __service?: T };

export class ServiceRegistry {
  private readonly values = new Map<symbol, unknown>();
  private readonly starters: Array<() => void | Promise<void>> = [];
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

  onStart(start: () => void | Promise<void>): void {
    if (this.frozen) throw new Error("Service registry is frozen");
    this.starters.push(start);
  }

  freeze(): void {
    this.frozen = true;
  }

  start(): Promise<void> {
    this.startPromise ??= (async () => {
      for (const start of this.starters) await start();
    })();
    return this.startPromise;
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
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

  resolve(request: Request): AccessLevel {
    const path = new URL(request.url).pathname;
    const method = request.method.toUpperCase();
    const rule = [...this.rules]
      .reverse()
      .find((candidate) =>
        (candidate.method === "*" || candidate.method === method) && candidate.matcher.test(path)
      );
    return rule?.level ?? "session";
  }
}

export interface RequestGuardContext {
  request: Request;
  remoteAddress?: string;
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

export const DATABASE = Symbol("database") as ServiceKey<Database>;
export const READINESS = Symbol("readiness") as ServiceKey<ReadinessService>;
export const LOGGER = Symbol("logger") as ServiceKey<Logger>;
export const ACCESS_POLICY = Symbol("access-policy") as ServiceKey<AccessPolicy>;
export const REQUEST_GUARDS = Symbol("request-guards") as ServiceKey<RequestGuardRegistry>;
export const REQUEST_IDENTITY = Symbol("request-identity") as ServiceKey<RequestIdentity>;
export const OPENAPI = Symbol("openapi") as ServiceKey<OpenApiRegistry>;

export interface AppContext {
  env: AppEnv;
  services: ServiceRegistry;
  database: Database;
  readiness: ReadinessService;
  logger: Logger;
  accessPolicy: AccessPolicy;
  requestGuards: RequestGuardRegistry;
  openapi: OpenApiRegistry;
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
  const readiness = new ReadinessService();
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
  services.register(READINESS, readiness);
  services.register(LOGGER, logger);
  services.register(ACCESS_POLICY, accessPolicy);
  services.register(REQUEST_GUARDS, requestGuards);
  services.register(REQUEST_IDENTITY, { userId: async () => undefined });
  services.register(OPENAPI, openapiRegistry);
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
  };
}
