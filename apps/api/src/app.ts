import { cors } from "@elysia/cors";
import { openapi } from "@elysia/openapi";
import { AppException, type ErrorEnvelope } from "@podosoft/podokit-contracts";
import { Elysia } from "elysia";
import { configureServices, extensionModules } from "./app.extensions";
import { validateEnv, type AppEnv } from "./config/env.validation";
import { assertSelectedProvidersInstalled } from "./config/provider-selection";
import { PROVIDERS } from "./config/providers";
import { stampClientAddress } from "./core/client-address";
import {
  appContext,
  createCoreServices,
  type AppPlugin,
  type OpenApiContribution,
  type PodokitModule,
  type ServiceRegistry,
} from "./core/services";
import { isDatabaseUnavailable } from "./database/database";
import { healthPlugin } from "./health/health.plugin";
// podokit:begin:imports
import { authModule } from "./auth/auth.module";
import { storageModule } from "./storage/storage.module";
import { storageLocalModule } from "./storage-local/storage-local.module";
import { adminModule } from "./admin.module";
import { auditModule } from "./audit/audit.module";
import { redisModule } from "./redis/redis.module";
import { cacheMemoryModule } from "./cache-memory/cache-memory.module";
import { apiKeyModule } from "./api-key/api-key.module";
import { rateLimitModule } from "./rate-limit/rate-limit.module";
import { eventsRedisModule } from "./events-provider-redis/events-redis.module";
import { eventsMemoryModule } from "./events-provider-memory/events-memory.module";
import { eventsModule } from "./events/events.module";
import { jobsModule } from "./jobs/jobs.module";
import { loggingModule } from "./logging/logging.module";
import { jobsLocalModule } from "./jobs-local/jobs-local.module";
// podokit:end:imports

export interface CreateAppOptions {
  env?: AppEnv;
  services?: ServiceRegistry;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function mergeOpenApi(
  base: Record<string, unknown>,
  contributions: Array<{ document: Record<string, unknown>; pathPrefix?: string }>,
): Record<string, unknown> {
  const paths = { ...record(base.paths) };
  const components = { ...record(base.components) };
  const tags = Array.isArray(base.tags) ? [...base.tags] : [];

  for (const contribution of contributions) {
    const prefix = contribution.pathPrefix?.replace(/\/$/, "") ?? "";
    for (const [path, operations] of Object.entries(record(contribution.document.paths))) {
      paths[`${prefix}${path}`] = operations;
    }
    for (const [group, values] of Object.entries(record(contribution.document.components))) {
      components[group] = { ...record(components[group]), ...record(values) };
    }
    if (Array.isArray(contribution.document.tags)) {
      for (const tag of contribution.document.tags) {
        const name = record(tag).name;
        if (!tags.some((candidate) => record(candidate).name === name)) tags.push(tag);
      }
    }
  }
  return { ...base, paths, components, tags };
}

export interface OpenApiDocumentSource {
  routeCount: () => number;
  base: () => Promise<Response>;
  contributions: () => Promise<OpenApiContribution[]>;
}

export type OpenApiDocumentLoader = () => Promise<Record<string, unknown> | Response>;

function sameContributions(left: OpenApiContribution[], right: OpenApiContribution[]): boolean {
  return left.length === right.length && left.every((contribution, index) =>
    contribution.document === right[index]?.document &&
    contribution.pathPrefix === right[index]?.pathPrefix
  );
}

/** Contributors return the same document object while their inputs are unchanged,
 *  so identity plus the route count (the base spec's own cache key) identifies the
 *  merged result without a staleness window. */
export function cachedOpenApiDocument(source: OpenApiDocumentSource): OpenApiDocumentLoader {
  let cached: {
    routeCount: number;
    contributions: OpenApiContribution[];
    document: Record<string, unknown>;
  } | undefined;
  return async () => {
    const contributions = await source.contributions();
    const routeCount = source.routeCount();
    if (
      cached?.routeCount === routeCount &&
      sameContributions(cached.contributions, contributions)
    ) {
      return cached.document;
    }
    const response = await source.base();
    if (!response.ok) return response;
    const document = mergeOpenApi(record(await response.json()), contributions);
    cached = { routeCount, contributions, document };
    return document;
  };
}

/** Seconds a client should wait before retrying a request that failed with 503. */
export const UNAVAILABLE_RETRY_AFTER_SECONDS = 1;

/** Adds `Retry-After` to a 503 unless the code that failed the request already chose one. */
export function setRetryAfter(headers: Record<string, string | number>): void {
  if (Object.keys(headers).some((name) => name.toLowerCase() === "retry-after")) return;
  headers["retry-after"] = String(UNAVAILABLE_RETRY_AFTER_SECONDS);
}

function errorEnvelope(
  code: string,
  message: string,
  statusCode: number,
  path: string,
  details?: unknown,
): ErrorEnvelope {
  return {
    success: false,
    error: {
      code,
      message,
      statusCode,
      path,
      timestamp: new Date().toISOString(),
      ...(details === undefined ? {} : { details }),
    },
  };
}

export interface ErrorResponseState {
  status?: number | string;
  headers: Record<string, string | number>;
}

/**
 * Renders a failed request as the standard error envelope: an AppException with
 * its code, status, and details; an unreachable database as 503; Elysia's
 * validation and routing errors as 400 and 404; anything else as 500 without
 * its message.
 */
export function renderError(code: unknown, error: unknown, path: string, set: ErrorResponseState): ErrorEnvelope {
  if (error instanceof AppException) {
    set.status = error.statusCode;
    if (error.statusCode === 503) setRetryAfter(set.headers);
    return errorEnvelope(error.code, error.message, error.statusCode, path, error.details);
  }
  if (isDatabaseUnavailable(error)) {
    set.status = 503;
    setRetryAfter(set.headers);
    return errorEnvelope("DATABASE_UNAVAILABLE", "The database is temporarily unavailable", 503, path);
  }
  const statusCode = code === "NOT_FOUND" ? 404 : code === "VALIDATION" ? 400 : 500;
  set.status = statusCode;
  const publicCode = code === "NOT_FOUND"
    ? "NOT_FOUND"
    : code === "VALIDATION"
      ? "VALIDATION_ERROR"
      : "INTERNAL_ERROR";
  const message = statusCode === 500
    ? "Internal server error"
    : error instanceof Error
      ? error.message
      : "Request failed";
  return errorEnvelope(publicCode, message, statusCode, path);
}

const buildApp = (options: CreateAppOptions = {}) => {
  const env = options.env ?? validateEnv(process.env);
  const services = options.services ?? createCoreServices(env);
  const modules: PodokitModule[] = [
    // podokit:begin:modules
    authModule,
    storageModule,
    storageLocalModule,
    adminModule,
    auditModule,
    redisModule,
    cacheMemoryModule,
    apiKeyModule,
    rateLimitModule,
    eventsRedisModule,
    eventsMemoryModule,
    eventsModule,
    jobsModule,
    loggingModule,
    jobsLocalModule,
    // podokit:end:modules
    ...extensionModules,
  ];
  for (const module of modules) module.configure?.(env, services);
  configureServices(services);
  assertSelectedProvidersInstalled(services, PROVIDERS);
  services.freeze();
  const context = appContext(env, services);
  const corsOrigin = env.CORS_ORIGIN?.split(",").map((origin) => origin.trim());
  const clientAddressConfig = { trustedProxyHops: env.TRUSTED_PROXY_HOPS, header: env.TRUSTED_PROXY_HEADER };

  const app = new Elysia({ name: "podokit" })
    .use(cors({ origin: corsOrigin ?? true, credentials: true }))
    .use(
      openapi({
        path: "/api-docs",
        specPath: "/api-docs-elysia-json",
        scalar: { url: "/api-docs-json" },
        documentation: {
          info: {
            title: "pdmux API",
            description: "Generated with PodoKit",
            version: "1.0.0",
          },
        },
      }),
    )
    .onRequest(async ({ request, server, set }) => {
      const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
      set.headers["x-request-id"] = requestId;
      const remoteAddress = server?.requestIP(request)?.address;
      const clientAddress = stampClientAddress(request, remoteAddress, clientAddressConfig);
      await context.requestGuards.run({
        request,
        ...(remoteAddress ? { remoteAddress } : {}),
        ...(clientAddress ? { clientAddress } : {}),
        setHeader: (name, value) => { set.headers[name] = value; },
      });
    })
    .onAfterResponse(({ request, set }) => {
      context.logger.info(
        { method: request.method, path: new URL(request.url).pathname, statusCode: set.status },
        "Complete request",
      );
    })
    .onError(({ code, error, path, set }) => renderError(code, error, path, set));

  const plugins: AppPlugin[] = [
    healthPlugin,
    ...modules.flatMap((module) => module.plugin ? [module.plugin] : []),
  ];
  for (const plugin of plugins) app.use(plugin(context));
  const openApiDocument = cachedOpenApiDocument({
    routeCount: () => app.routes.length,
    base: () => app.handle(new Request("http://localhost/api-docs-elysia-json")),
    contributions: () => context.openapi.contributions(),
  });
  app.get("/api-docs-json", () => openApiDocument(), {
    detail: { hide: true },
  });
  app.onStop(() => { void services.close(); });
  return app;
};

export type PodokitApp = ReturnType<typeof buildApp>;

export function createApp(options: CreateAppOptions = {}): PodokitApp {
  return buildApp(options);
}
