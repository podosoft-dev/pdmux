import "dotenv/config";
import { DataSource, type DataSourceOptions } from "typeorm";
import type { DatabaseProviderName } from "@podosoft/podokit-runtime";
import { PROVIDERS } from "../config/providers";
import { validateEnv } from "../config/env.validation";
import { databaseUrl, sqliteDatabasePath } from "./database";
import { APP_ENTITIES } from "./entities";
import { migrationPaths, migrationSet } from "./migration-files";

/** The migrations the data source loads; compare them with `assertMigrationsLoaded`. */
export const appMigrations = migrationSet();

const commonOptions = {
  entities: APP_ENTITIES,
  migrations: migrationPaths(appMigrations),
  // One transaction per migration, so a migration can set `transaction = false`
  // for statements such as CREATE INDEX CONCURRENTLY.
  migrationsTransactionMode: "each" as const,
  synchronize: false,
};

const env = validateEnv(process.env);
function databaseProvider(): DatabaseProviderName {
  return PROVIDERS.database;
}

export const dataSourceOptions: DataSourceOptions = databaseProvider() === "sqlite"
  ? {
      type: "better-sqlite3",
      database: sqliteDatabasePath(databaseUrl(env)),
      enableWAL: true,
      ...commonOptions,
    }
  : {
      type: "postgres",
      ...(process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : {}),
      host: env.POSTGRES_HOST,
      port: env.POSTGRES_PORT,
      username: env.POSTGRES_USER,
      password: env.POSTGRES_PASSWORD,
      database: env.POSTGRES_DB,
      ...commonOptions,
    };

// The TypeORM CLI (see package.json scripts) takes the file's only DataSource export.
export const appDataSource = new DataSource(dataSourceOptions);
