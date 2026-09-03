import "dotenv/config";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

const compiledMigrations = join(process.cwd(), "dist", "migrations");
const migrations = existsSync(compiledMigrations)
  ? [join(compiledMigrations, "[0-9]*.js")]
  : [join(process.cwd(), "src", "migrations", "[0-9]*.ts")];

export const dataSourceOptions: DataSourceOptions = {
  type: "postgres",
  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  username: process.env.POSTGRES_USER ?? "podokit",
  password: process.env.POSTGRES_PASSWORD ?? "podokit",
  database: process.env.POSTGRES_DB ?? "podokit",
  entities: [
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
  ],
  migrations,
  synchronize: false,
};

// Used by the TypeORM CLI for migrations (see package.json scripts).
export default new DataSource(dataSourceOptions);
