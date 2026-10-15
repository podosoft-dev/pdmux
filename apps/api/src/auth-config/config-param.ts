import type { DatabaseProviderName } from "@podosoft/podokit-runtime";

// PostgreSQL stores a jsonb object only when bound as an object (P-022), while
// SQLite keeps the column as text and rejects object parameters.
export function authConfigParam(
  provider: DatabaseProviderName,
  config: Record<string, unknown>,
): Record<string, unknown> | string {
  return provider === "sqlite" ? JSON.stringify(config) : config;
}
