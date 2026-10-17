import { DataSource, type DataSourceOptions } from "typeorm";
import { validateEnv } from "../config/env.validation";
import { PROVIDERS } from "../config/providers";
import { providersFromEnvironment } from "../config/provider-selection";
import { databaseUrl, sqliteDatabasePath } from "./database";
import { APP_ENTITIES } from "./entities";
import { migrationPaths, migrationSet, type MigrationSet } from "./migration-files";
import { BunSqliteDatabaseAdapter, installPdmuxSqliteDriver } from "./sqlite-driver";

/**
 * The data source pdmux's services read and write through. The managed
 * data-source.ts serves the migration runner and the TypeORM CLI; this one adds
 * the desktop SQLite provider, which TypeORM reaches through Bun's SQLite
 * (sqlite-driver.ts) and whose product tables come from entity synchronization:
 * pdmux migrations are PostgreSQL-only.
 */
export function createDataSourceOptions(
  env: NodeJS.ProcessEnv = process.env,
  migrations: MigrationSet = migrationSet(),
): DataSourceOptions {
  const appEnv = validateEnv(env);
  if (providersFromEnvironment(PROVIDERS, env).database === "sqlite") {
    return {
      type: "better-sqlite3",
      database: sqliteDatabasePath(databaseUrl(appEnv, "sqlite")),
      driver: BunSqliteDatabaseAdapter,
      enableWAL: true,
      entities: APP_ENTITIES,
      migrations: [],
      synchronize: true,
    };
  }
  return {
    type: "postgres",
    ...(env.DATABASE_URL ? { url: env.DATABASE_URL } : {}),
    host: appEnv.POSTGRES_HOST,
    port: appEnv.POSTGRES_PORT,
    username: appEnv.POSTGRES_USER,
    password: appEnv.POSTGRES_PASSWORD,
    database: appEnv.POSTGRES_DB,
    entities: APP_ENTITIES,
    migrations: migrationPaths(migrations),
    // One transaction per migration, so a migration can set `transaction = false`
    // for statements such as CREATE INDEX CONCURRENTLY.
    migrationsTransactionMode: "each",
    synchronize: false,
  };
}

export function createAppDataSource(options: DataSourceOptions = createDataSourceOptions()): DataSource {
  const source = new DataSource(options);
  return options.type === "better-sqlite3" ? installPdmuxSqliteDriver(source) : source;
}
