import { Database as SqliteDatabase } from "bun:sqlite";
import type { SQL } from "bun";
import type { AuthConfigRow, ConfigVersions } from "@podosoft/podokit-auth";
import type { DatabaseProviderName } from "@podosoft/podokit-runtime";
import { validateEnv } from "../config/env.validation";
import { PROVIDERS } from "../config/providers";
import { databaseUrl, sqliteDatabasePath } from "../database/database";
import { answersWithin, sharedProbe, type DatabaseProbe } from "./database-outage";
import { isMaintenanceCommand } from "./maintenance";
import { AuthPostgresPool } from "./postgres-pool";

const env = validateEnv(process.env);
const url = databaseUrl(env);
function databaseProvider(): DatabaseProviderName {
  return PROVIDERS.database;
}
const provider = databaseProvider();

export const postgresPool = provider === "postgres"
  ? new AuthPostgresPool({
      connectionString: url,
      max: env.DB_AUTH_POOL_MAX,
      connectionTimeoutMillis: env.DB_CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
      ...(isMaintenanceCommand() ? {} : { query_timeout: env.DB_QUERY_TIMEOUT_MS }),
    })
  : null;

export const sqliteDatabase = provider === "sqlite"
  ? new SqliteDatabase(sqliteDatabasePath(url), { create: true, strict: true })
  : null;

export const authDatabase = postgresPool ?? sqliteDatabase;
if (!authDatabase) throw new Error("No authentication database is configured");

/** Whether the authentication database answers `SELECT 1` within the readiness check timeout. */
export const authDatabaseReachable: DatabaseProbe = sharedProbe(async () => {
  if (!postgresPool) return true;
  return answersWithin(() => postgresPool.query("SELECT 1"), env.READINESS_CHECK_TIMEOUT_MS);
});

let queryDatabase: SQL | undefined;

export function configureAuthQueryDatabase(sql: SQL): void {
  queryDatabase = sql;
}

function queries(): SQL {
  if (!queryDatabase) throw new Error("Authentication query database is not configured");
  return queryDatabase;
}

export async function readAppSettings(): Promise<Array<{ key: string; value: string }>> {
  const sql = queries();
  return sql<Array<{ key: string; value: string }>>`
    SELECT "key", "value" FROM "app_setting"
  `;
}

export async function readAuthConfig(): Promise<AuthConfigRow[]> {
  const sql = queries();
  const rows = await sql<Array<Omit<AuthConfigRow, "enabled"> & { enabled: boolean | number }>>`
    SELECT "key", "enabled", "config", "secret", "updatedAt" FROM "auth_config"
  `;
  return rows.map((row) => ({ ...row, enabled: row.enabled === true || row.enabled === 1 }));
}

type VersionRow = {
  authConfigCount: number | string | bigint;
  authConfigUpdatedAt: string | null;
  appSettingCount: number | string | bigint;
  appSettingUpdatedAt: string | null;
};

/** One cheap statement that changes whenever either settings table changes. The
 *  count catches deletes; the text cast keeps PostgreSQL's microsecond precision. */
export async function readConfigVersions(): Promise<ConfigVersions> {
  const sql = queries();
  const [row] = await sql<VersionRow[]>`
    SELECT
      (SELECT count(*) FROM "auth_config") AS "authConfigCount",
      (SELECT CAST(max("updatedAt") AS TEXT) FROM "auth_config") AS "authConfigUpdatedAt",
      (SELECT count(*) FROM "app_setting") AS "appSettingCount",
      (SELECT CAST(max("updatedAt") AS TEXT) FROM "app_setting") AS "appSettingUpdatedAt"
  `;
  return {
    authConfig: `${String(row?.authConfigCount ?? 0)}:${row?.authConfigUpdatedAt ?? ""}`,
    appSettings: `${String(row?.appSettingCount ?? 0)}:${row?.appSettingUpdatedAt ?? ""}`,
  };
}

export async function closeAuthDatabase(): Promise<void> {
  if (postgresPool) await postgresPool.end();
  sqliteDatabase?.close();
}
