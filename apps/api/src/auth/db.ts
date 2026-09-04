import { Database as SqliteDatabase, type SQLQueryBindings } from "bun:sqlite";
import type { Pool as PoolType } from "pg";
import { Pool } from "pg";
import { validateEnv } from "../config/env.validation";
import { databaseUrl, sqliteDatabasePath } from "../database/database";
import { runtimeProviders } from "../runtime/providers";

export interface QueryRows {
  query<Row extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }>;
}

function sqliteBinding(value: unknown): SQLQueryBindings {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) return value;
  if (ArrayBuffer.isView(value)) return value as NodeJS.TypedArray;
  throw new TypeError(`Unsupported authentication database binding: ${typeof value}`);
}

const env = validateEnv(process.env);
const provider = runtimeProviders(process.env).database;
const url = databaseUrl(env, provider);

export const postgresPool = provider === "postgres" ? new Pool({ connectionString: url }) : null;
export const sqliteDatabase = provider === "sqlite"
  ? new SqliteDatabase(sqliteDatabasePath(url), { create: true, strict: true })
  : null;

export const authDatabase = postgresPool ?? sqliteDatabase;
if (!authDatabase) throw new Error("No authentication database is configured");

export const queryRows: QueryRows = {
  query: async <Row extends Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: Row[] }> => {
    if (postgresPool) {
      const result = await postgresPool.query<Row>(sql, [...values]);
      return { rows: result.rows };
    }
    if (!sqliteDatabase) throw new Error("No authentication query database is configured");
    const statement = sqliteDatabase.prepare<Row, SQLQueryBindings[]>(sql);
    return { rows: statement.all(...values.map(sqliteBinding)) };
  },
};

/** Compatibility boundary for the currently released auth helper. Its runtime
 * contract is only query(), while the next PodoKit release exposes that shape. */
export const authConfigQueryClient = queryRows as unknown as PoolType;

export async function readAppSettings(): Promise<Array<{ key: string; value: string }>> {
  const result = await queryRows.query<{ key: string; value: string }>(
    'SELECT "key", "value" FROM "app_setting"',
  );
  return result.rows;
}

export async function closeAuthDatabase(): Promise<void> {
  if (postgresPool) await postgresPool.end();
  sqliteDatabase?.close();
}
