import "dotenv/config";
import { DataSource, type DataSourceOptions } from "typeorm";
import { AgentAuthFailure } from "../agents/agent-auth-failure.entity";
import { AgentEnrollment } from "../agents/agent-enrollment.entity";
import { AgentToken } from "../agents/agent-token.entity";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { RepoCommit } from "../git/repo-commit.entity";
import { RepoRef } from "../git/repo-ref.entity";
import { Repo } from "../git/repo.entity";
import { HostGitRoot } from "../hosts/host-git-root.entity";
import { HostService } from "../hosts/host-service.entity";
import { Host } from "../hosts/host.entity";
import { HostMcpKey } from "../mcp/host-mcp-key.entity";
import { UserMcpKey } from "../mcp/user-mcp-key.entity";
import { HostMetricSample } from "../metrics/host-metric-sample.entity";
import { UserHostPref } from "../prefs/user-host-pref.entity";
import { UserLayout } from "../prefs/user-layout.entity";
import { HostConnector } from "../integrations/host-connector.entity";
import { IntegrationConnection } from "../integrations/integration-connection.entity";
import { ServiceExposure } from "../integrations/service-exposure.entity";
import { runtimeProviders } from "../runtime/providers";
import { validateEnv } from "../config/env.validation";
import { databaseUrl, sqliteDatabasePath } from "./database";
import { BunSqliteDatabaseAdapter, installPdmuxSqliteDriver } from "./sqlite-driver";
import { POSTGRES_MIGRATIONS } from "./migrations";

const entities = [
  AgentAuthFailure,
  AgentEnrollment,
  AgentToken,
  FleetSetting,
  Host,
  HostConnector,
  HostGitRoot,
  HostMcpKey,
  HostMetricSample,
  HostService,
  IntegrationConnection,
  Repo,
  RepoCommit,
  RepoRef,
  ServiceExposure,
  UserHostPref,
  UserLayout,
  UserMcpKey,
];

export function createDataSourceOptions(env: NodeJS.ProcessEnv = process.env): DataSourceOptions {
  const providers = runtimeProviders(env);
  if (providers.database === "sqlite") {
    const appEnv = validateEnv(env);
    return {
      type: "better-sqlite3",
      database: sqliteDatabasePath(databaseUrl(appEnv, providers.database)),
      driver: BunSqliteDatabaseAdapter,
      enableWAL: true,
      entities,
      migrations: [],
      synchronize: true,
    };
  }
  return {
    type: "postgres",
    host: env.POSTGRES_HOST ?? "localhost",
    port: Number(env.POSTGRES_PORT ?? 5432),
    username: env.POSTGRES_USER ?? "podokit",
    password: env.POSTGRES_PASSWORD ?? "podokit",
    database: env.POSTGRES_DB ?? "podokit",
    entities,
    migrations: POSTGRES_MIGRATIONS,
    synchronize: false,
  };
}

export const dataSourceOptions: DataSourceOptions = createDataSourceOptions();

export function createAppDataSource(options: DataSourceOptions = dataSourceOptions): DataSource {
  const source = new DataSource(options);
  return options.type === "better-sqlite3" ? installPdmuxSqliteDriver(source) : source;
}

export const entityTypes = entities;

// Used by the TypeORM CLI for migrations (see package.json scripts).
export default createAppDataSource();
