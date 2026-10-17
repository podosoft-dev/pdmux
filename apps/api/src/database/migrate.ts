import { Database as SqliteDatabase } from "bun:sqlite";
import type { DatabaseProviderName } from "@podosoft/podokit-runtime";
import { validateEnv } from "../config/env.validation";
import { PROVIDERS } from "../config/providers";
import { databaseUrl, sqliteDatabasePath } from "./database";
import { assertMigrationsLoaded, loadMigrations, migrationName, migrationSet } from "./migration-files";
import { revertLatestSqliteMigration, runSqliteMigrations } from "./sqlite-migrator";

function databaseProvider(): DatabaseProviderName {
  return PROVIDERS.database;
}

/** Prints the migrations this build runs, one name per line, without a database. */
async function list(): Promise<void> {
  const set = migrationSet();
  const loaded = await loadMigrations(set);
  for (const { migration } of loaded) process.stdout.write(`${migrationName(migration)}\n`);
  process.stderr.write(`${loaded.length} migrations in ${set.directory}\n`);
}

async function migrate(): Promise<void> {
  if (databaseProvider() === "sqlite") {
    const env = validateEnv(process.env);
    const database = new SqliteDatabase(sqliteDatabasePath(databaseUrl(env)), { create: true });
    try {
      if (process.argv.includes("--revert")) await revertLatestSqliteMigration(database);
      else await runSqliteMigrations(database);
    } finally {
      database.close();
    }
    return;
  }
  const { appDataSource: dataSource, appMigrations } = await import("./data-source.js");
  await dataSource.initialize();
  try {
    assertMigrationsLoaded(dataSource.migrations, appMigrations);
    if (process.argv.includes("--revert")) await dataSource.undoLastMigration({ transaction: "all" });
    else await dataSource.runMigrations();
  } finally {
    await dataSource.destroy();
  }
}

void (process.argv.includes("--list") ? list() : migrate()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Migration failed: ${message}\n`);
  process.exitCode = 1;
});
