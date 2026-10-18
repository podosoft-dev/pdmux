import { DesktopConnection } from "../desktop/desktop-connection.entity";
import { DesktopRecord } from "../desktop/desktop-record.entity";
import type { DataSourceOptions } from "typeorm";
import { AgentAuthFailure } from "../agents/agent-auth-failure.entity";
import { AgentEnrollment } from "../agents/agent-enrollment.entity";
import { AgentToken } from "../agents/agent-token.entity";
import { FileTransfer, FileTransferEntry } from "../file-transfers/file-transfer.entity";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { RepoCommit } from "../git/repo-commit.entity";
import { RepoRef } from "../git/repo-ref.entity";
import { Repo } from "../git/repo.entity";
import { HostGitRoot } from "../hosts/host-git-root.entity";
import { HostService } from "../hosts/host-service.entity";
import { Host } from "../hosts/host.entity";
import { HostConnector } from "../integrations/host-connector.entity";
import { IntegrationConnection } from "../integrations/integration-connection.entity";
import { ServiceExposure } from "../integrations/service-exposure.entity";
import { HostMcpKey } from "../mcp/host-mcp-key.entity";
import { UserMcpKey } from "../mcp/user-mcp-key.entity";
import { HostMetricSample } from "../metrics/host-metric-sample.entity";
import { UserHostPref } from "../prefs/user-host-pref.entity";
import { UserLayout } from "../prefs/user-layout.entity";

// This owned file is never overwritten by `podo update`. List the
// application's TypeORM entities here: the migration data source loads them,
// so `migration:generate` compares them with the database and code that uses
// `appDataSource` gets their repositories. pdmux's runtime data source
// (app-data-source.ts) loads the same list.
export type AppEntities = NonNullable<DataSourceOptions["entities"]>;

export const APP_ENTITIES = [
  DesktopRecord,
  DesktopConnection,
  FileTransfer,
  FileTransferEntry,
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
] satisfies AppEntities;
