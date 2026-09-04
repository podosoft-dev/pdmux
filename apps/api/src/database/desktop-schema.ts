import type { SQL } from "bun";
import { FLAG_DEFAULTS } from "../settings/flag-defaults";

/** Tables owned by PodoKit modules rather than TypeORM product entities. The
 * statements are idempotent so every desktop upgrade can repair an interrupted
 * first launch before Better Auth and entity synchronization run. */
export async function initializeDesktopSchema(sql: SQL): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS "app_setting" (
      "key" text NOT NULL PRIMARY KEY,
      "value" text NOT NULL,
      "updatedAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  for (const [key, enabled] of Object.entries(FLAG_DEFAULTS)) {
    await sql`
      INSERT INTO "app_setting" ("key", "value") VALUES (${key}, ${String(enabled)})
      ON CONFLICT ("key") DO NOTHING
    `;
  }
  await sql`
    CREATE TABLE IF NOT EXISTS "auth_config" (
      "key" text NOT NULL PRIMARY KEY,
      "enabled" integer NOT NULL DEFAULT 0,
      "config" text NOT NULL DEFAULT '{}',
      "secret" text,
      "updatedAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS "audit_logs" (
      "id" text NOT NULL PRIMARY KEY,
      "action" text NOT NULL,
      "actorId" text,
      "actorName" text,
      "actorEmail" text,
      "targetType" text,
      "targetId" text,
      "targetLabel" text,
      "ip" text,
      "metadata" text,
      "createdAt" datetime NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_action" ON "audit_logs" ("action")`;
  await sql`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_createdAt" ON "audit_logs" ("createdAt")`;
}
