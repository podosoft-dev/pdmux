import { describe, expect, it } from "bun:test";
import type { DatabaseProviderName } from "@podosoft/podokit-runtime";
import { validateEnv } from "../config/env.validation";
import { PROVIDERS } from "../config/providers";
import { postgresPool } from "./db";
import { AuthPostgresPool } from "./postgres-pool";

function databaseProvider(): DatabaseProviderName {
  return PROVIDERS.database;
}

describe("auth database pool", () => {
  it("applies the pool limits and the query timeout from the environment", () => {
    if (databaseProvider() !== "postgres") {
      expect(postgresPool).toBeNull();
      return;
    }
    const env = validateEnv(process.env);
    expect(postgresPool).toBeInstanceOf(AuthPostgresPool);
    expect(postgresPool?.options).toMatchObject({
      max: env.DB_AUTH_POOL_MAX,
      connectionTimeoutMillis: env.DB_CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
      query_timeout: env.DB_QUERY_TIMEOUT_MS,
    });
  });
});
