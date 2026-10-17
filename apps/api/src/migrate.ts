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
import { assertMigrationsLoaded } from "./database/migration-files";
import { runSqliteMigrations } from "./database/sqlite-migrator";

async function runMigrations(): Promise<void> {
  if (postgresPool) {
    await migrateLegacyAccountIssuers(postgresAccountIssuerMigrationDatabase(postgresPool));
  }
  if (sqliteDatabase) migrateSqliteLegacyAccountIssuers(sqliteDatabase);

  const authMigrations = await getMigrations(auth.options);
  await authMigrations.runMigrations();

  if (sqliteDatabase) {
    await runSqliteMigrations(sqliteDatabase);
  } else {
    const { appDataSource: dataSource, appMigrations } = await import("./database/data-source.js");
    await dataSource.initialize();
    try {
      assertMigrationsLoaded(dataSource.migrations, appMigrations);
      await dataSource.runMigrations();
    } finally {
      await dataSource.destroy();
    }
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
