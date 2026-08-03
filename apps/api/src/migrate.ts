import { getMigrations } from "better-auth/db/migration";
import { auth } from "./auth/auth";
import { pool } from "./auth/db";
import dataSource from "./database/data-source";

async function runMigrations(): Promise<void> {
  const authMigrations = await getMigrations(auth.options);
  await authMigrations.runMigrations();

  await dataSource.initialize();
  await dataSource.runMigrations();
}

runMigrations()
  .catch((error: unknown) => {
    console.error("Run database migrations failed", error);
    process.exitCode = 1;
  })
  .finally(async (): Promise<void> => {
    if (dataSource.isInitialized) await dataSource.destroy();
    await pool.end();
  });
