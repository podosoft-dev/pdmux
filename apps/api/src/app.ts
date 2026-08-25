import { cors } from "@elysia/cors";
import { openapi } from "@elysia/openapi";
import { AppException, type ErrorEnvelope } from "@podosoft/podokit-contracts";
import { Elysia } from "elysia";
import { configureServices, extensionModules } from "./app.extensions";
import { validateEnv, type AppEnv } from "./config/env.validation";
import {
  appContext,
  createCoreServices,
  type AppPlugin,
  type PodokitModule,
  type ServiceRegistry,
} from "./core/services";
import { healthPlugin } from "./health/health.plugin";
// podokit:begin:imports
import { authModule } from "./auth/auth.module";
import { storageModule } from "./storage/storage.module";
import { adminModule } from "./admin.module";
import { auditModule } from "./audit/audit.module";
import { redisModule } from "./redis/redis.module";
import { apiKeyModule } from "./api-key/api-key.module";
import { rateLimitModule } from "./rate-limit/rate-limit.module";
import { eventsModule } from "./events/events.module";
import { jobsModule } from "./jobs/jobs.module";
import { loggingModule } from "./logging/logging.module";
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

const buildApp = (options: CreateAppOptions = {}) => {
  const env = options.env ?? validateEnv(process.env);
  const services = options.services ?? createCoreServices(env);
  const modules: PodokitModule[] = [
    // podokit:begin:modules
    authModule,
    storageModule,
    adminModule,
    auditModule,
    redisModule,
    apiKeyModule,
    rateLimitModule,
    eventsModule,
    jobsModule,
    loggingModule,
    // podokit:end:modules
    ...extensionModules,
  ];
  for (const module of modules) module.configure?.(env, services);
  configureServices(services);
  services.freeze();
  const context = appContext(env, services);
  const corsOrigin = env.CORS_ORIGIN?.split(",").map((origin) => origin.trim());

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
      await context.requestGuards.run({
        request,
        ...(server?.requestIP(request)?.address
          ? { remoteAddress: server.requestIP(request)?.address }
          : {}),
        setHeader: (name, value) => { set.headers[name] = value; },
      });
    })
    .onAfterResponse(({ request, set }) => {
      context.logger.info(
        { method: request.method, path: new URL(request.url).pathname, statusCode: set.status },
        "Complete request",
      );
    })
    .onError(({ code, error, path, set }) => {
      if (error instanceof AppException) {
        set.status = error.statusCode;
        return errorEnvelope(error.code, error.message, error.statusCode, path);
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
    });

  const plugins: AppPlugin[] = [
    healthPlugin,
    ...modules.flatMap((module) => module.plugin ? [module.plugin] : []),
  ];
  for (const plugin of plugins) app.use(plugin(context));
  app.get("/api-docs-json", async () => {
    const response = await app.handle(new Request("http://localhost/api-docs-elysia-json"));
    const base = record(await response.json());
    return mergeOpenApi(base, await context.openapi.contributions());
  }, {
    detail: { hide: true },
  });
  app.onStop(() => { void services.close(); });
  return app;
};

export type PodokitApp = ReturnType<typeof buildApp>;

export function createApp(options: CreateAppOptions = {}): PodokitApp {
  return buildApp(options);
}
