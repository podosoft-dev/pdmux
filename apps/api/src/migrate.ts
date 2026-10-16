// Keep this first: Better Auth checks the schema when ./auth/auth creates its
// instance, the migrations below are what make that schema match, and they may
// run longer than the auth pool's query timeout.
import "./auth/maintenance-command";
import { getMigrations } from "better-auth/db/migration";
import { auth } from "./auth/auth";
import { closeAuthDatabase, postgresPool, sqliteDatabase } from "./auth/db";
import {
  migrateLegacyAccountIssuers,
  migrateSqliteLegacyAccountIssuers,
  postgresAccountIssuerMigrationDatabase,
} from "./auth/account-issuer-migration";
import { validateEnv } from "./config/env.validation";
import { Database } from "./database/database";
import { initializeDesktopSchema } from "./database/desktop-schema";
import { assertMigrationsApplied } from "./database/schema-readiness";

// pdmux migrations are PostgreSQL-only. On the desktop SQLite provider the module
// tables come from initializeDesktopSchema and product tables from entity
// synchronization, so the SQLite migration runner is not used.
async function initializeSqliteSchema(): Promise<void> {
  const database = new Database(validateEnv(process.env));
  try {
    await database.connect();
    await initializeDesktopSchema(database.sql);
  } finally {
    await database.close();
  }
}

async function runMigrations(): Promise<void> {
  if (sqliteDatabase) await initializeSqliteSchema();
  if (postgresPool) {
    await migrateLegacyAccountIssuers(postgresAccountIssuerMigrationDatabase(postgresPool));
  }
  if (sqliteDatabase) migrateSqliteLegacyAccountIssuers(sqliteDatabase);

  const authMigrations = await getMigrations(auth.options);
  await authMigrations.runMigrations();

  const { appDataSource: dataSource } = await import("./database/data-source.js");
  await dataSource.initialize();
  try {
    if (dataSource.options.type === "postgres") await dataSource.runMigrations();
    await assertMigrationsApplied(dataSource);
  } finally {
    await dataSource.destroy();
  }
}

runMigrations()
  .catch((error: unknown) => {
    console.error("Run database migrations failed", error);
    process.exitCode = 1;
  })
  .finally(async (): Promise<void> => {
    await closeAuthDatabase();
  });
