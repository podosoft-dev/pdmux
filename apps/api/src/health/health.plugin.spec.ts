import { SQL } from "bun";
import { afterEach, describe, expect, it } from "bun:test";
import type { DatabaseProviderName } from "@podosoft/podokit-runtime";
import { Elysia } from "elysia";
import { AppException } from "../common/app-exception";
import { validateEnv } from "../config/env.validation";
import { PROVIDERS } from "../config/providers";
import {
  appContext,
  createCoreServices,
  DATABASE,
  READINESS,
  type ServiceRegistry,
} from "../core/services";
import { Database } from "../database/database";
import type { ReadinessCheck } from "./readiness.service";
import { healthPlugin } from "./health.plugin";

const opened: ServiceRegistry[] = [];

function databaseProvider(): DatabaseProviderName {
  return PROVIDERS.database;
}

afterEach(async () => {
  for (const services of opened.splice(0)) await services.close();
});

async function readiness(
  options: { databaseUp: boolean; checks?: Record<string, ReadinessCheck> },
): Promise<{ status: number; body: unknown }> {
  const env = validateEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseProvider() === "sqlite"
      ? "sqlite://:memory:"
      : "postgres://podokit:podokit@localhost:5432/podokit",
    READINESS_CHECK_TIMEOUT_MS: "20",
    READINESS_CACHE_MS: "0",
  });
  const services = createCoreServices(env);
  opened.push(services);
  const sql = new SQL(":memory:", { adapter: "sqlite" });
  if (!options.databaseUp) await sql.close();
  const database = new Database(env, sql);
  services.override(DATABASE, database, () => database.close());
  for (const [name, check] of Object.entries(options.checks ?? {})) {
    services.resolve(READINESS).register(name, check);
  }
  const app = new Elysia()
    .onError(({ error, set }) => {
      set.status = error instanceof AppException ? error.statusCode : 500;
      return error instanceof AppException
        ? { code: error.code, message: error.message }
        : { code: "INTERNAL_ERROR" };
    })
    .use(healthPlugin(appContext(env, services)));
  const response = await app.handle(new Request("http://localhost/health/ready"));
  return { status: response.status, body: await response.json() };
}

describe("GET /health/ready", () => {
  it("reports the database as db and module checks separately", async () => {
    const result = await readiness({
      databaseUp: true,
      checks: { cache: () => Promise.resolve() },
    });

    expect(result).toEqual({
      status: 200,
      body: { status: "ready", db: "up", checks: { cache: "up" } },
    });
  });

  it("fails when the database is down and names it", async () => {
    const result = await readiness({ databaseUp: false });

    expect(result).toEqual({
      status: 503,
      body: { code: "READINESS_FAILED", message: "One or more dependencies are unavailable: db" },
    });
  });

  it("names every module check that is down", async () => {
    const result = await readiness({
      databaseUp: true,
      checks: {
        cache: () => Promise.resolve(),
        redis: () => Promise.reject(new Error("Connection closed")),
        events: () => Promise.reject(new Error("Event transport is not subscribed")),
      },
    });

    expect(result).toEqual({
      status: 503,
      body: { code: "READINESS_FAILED", message: "One or more dependencies are unavailable: redis, events" },
    });
  });

  it("fails when a module check exceeds its timeout", async () => {
    const result = await readiness({
      databaseUp: true,
      checks: { storage: () => new Promise<void>(() => {}) },
    });

    expect(result).toEqual({
      status: 503,
      body: { code: "READINESS_FAILED", message: "One or more dependencies are unavailable: storage" },
    });
  });
});
