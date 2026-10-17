// Keep this first, as in migrate.ts: Better Auth checks the schema when
// ./auth/auth creates its instance, and the steps below make that schema match.
import "./auth/maintenance-command";
import { getMigrations } from "better-auth/db/migration";
import { auth } from "./auth/auth";
import { closeAuthDatabase, sqliteDatabase } from "./auth/db";
import { migrateSqliteLegacyAccountIssuers } from "./auth/account-issuer-migration";
import { validateEnv } from "./config/env.validation";
import { createAppDataSource } from "./database/app-data-source";
import { Database } from "./database/database";
import { initializeDesktopSchema } from "./database/desktop-schema";

/**
 * The desktop shell's schema step, in place of migrate.ts. pdmux migrations are
 * PostgreSQL-only, so on SQLite the module tables come from the desktop schema
 * and the product tables from entity synchronization rather than from PodoKit's
 * SQLite migration runner.
 */
async function migrateDesktop(): Promise<void> {
  if (!sqliteDatabase) throw new Error("The desktop schema needs DATABASE_PROVIDER=sqlite");
  const database = new Database(validateEnv(process.env));
  try {
    await database.connect();
    await initializeDesktopSchema(database.sql);
  } finally {
    await database.close();
  }
  migrateSqliteLegacyAccountIssuers(sqliteDatabase);

  const authMigrations = await getMigrations(auth.options);
  await authMigrations.runMigrations();

  const source = createAppDataSource();
  await source.initialize();
  await source.destroy();
}

migrateDesktop()
  .catch((error: unknown) => {
    console.error("Run desktop migrations failed", error);
    process.exitCode = 1;
  })
  .finally(async (): Promise<void> => {
    await closeAuthDatabase();
  });
