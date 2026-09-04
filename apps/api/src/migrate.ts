import { getMigrations } from "better-auth/db/migration";
import { auth } from "./auth/auth";
import { closeAuthDatabase, postgresPool } from "./auth/db";
import {
  migrateLegacyAccountIssuers,
  postgresAccountIssuerMigrationDatabase,
} from "./auth/account-issuer-migration";
import dataSource from "./database/data-source";
import { Database } from "./database/database";
import { validateEnv } from "./config/env.validation";
import { initializeDesktopSchema } from "./database/desktop-schema";
import { runtimeProviders } from "./runtime/providers";

async function runMigrations(): Promise<void> {
  const providers = runtimeProviders(process.env);
  const database = new Database(validateEnv(process.env));
  try {
    if (providers.database === "sqlite") {
      await database.connect();
      await initializeDesktopSchema(database.sql);
    }
    if (postgresPool) {
      await migrateLegacyAccountIssuers(postgresAccountIssuerMigrationDatabase(postgresPool));
    }

    const authMigrations = await getMigrations(auth.options);
    await authMigrations.runMigrations();

    await dataSource.initialize();
    if (dataSource.options.type === "postgres") await dataSource.runMigrations();
  } finally {
    await database.close();
  }
}

runMigrations()
  .catch((error: unknown) => {
    console.error("Run database migrations failed", error);
    process.exitCode = 1;
  })
  .finally(async (): Promise<void> => {
    if (dataSource.isInitialized) await dataSource.destroy();
    await closeAuthDatabase();
  });
