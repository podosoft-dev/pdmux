import type { SQL } from "bun";
import type { DatabaseProviderName } from "@podosoft/podokit-runtime";
import { authConfigParam } from "./config-param";

export interface AuthConfigRow {
  key: string;
  enabled: boolean;
  config: unknown;
  secret: string | null;
}

function configObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      return configObject(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return {};
}

// SQLite stores booleans as 0 or 1.
interface StoredAuthConfigRow extends Omit<AuthConfigRow, "enabled"> {
  enabled: boolean | number;
}

function authConfigRow(row: StoredAuthConfigRow): AuthConfigRow {
  return { ...row, enabled: row.enabled === true || row.enabled === 1 };
}

export async function readAuthConfigRows(sql: SQL): Promise<AuthConfigRow[]> {
  const rows = await sql<StoredAuthConfigRow[]>`
    SELECT "key", "enabled", "config", "secret" FROM "auth_config"
  `;
  return rows.map(authConfigRow);
}

export async function readAuthConfigRow(sql: SQL, key: string): Promise<AuthConfigRow | null> {
  const rows = await sql<StoredAuthConfigRow[]>`
    SELECT "key", "enabled", "config", "secret"
    FROM "auth_config" WHERE "key" = ${key}
  `;
  return rows[0] ? authConfigRow(rows[0]) : null;
}

export async function writeAuthConfigRow(
  sql: SQL,
  provider: DatabaseProviderName,
  row: AuthConfigRow,
): Promise<void> {
  const config = authConfigParam(provider, configObject(row.config));
  await sql`
    INSERT INTO "auth_config" ("key", "enabled", "config", "secret", "updatedAt")
    VALUES (${row.key}, ${row.enabled}, ${config}, ${row.secret}, CURRENT_TIMESTAMP)
    ON CONFLICT ("key") DO UPDATE SET
      "enabled" = EXCLUDED."enabled",
      "config" = EXCLUDED."config",
      "secret" = EXCLUDED."secret",
      "updatedAt" = CURRENT_TIMESTAMP
  `;
}
