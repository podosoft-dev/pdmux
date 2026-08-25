import { Queue } from "bullmq";
import { DataSource } from "typeorm";
import { AgentAckService } from "../agents/agent-ack.service";
import { AgentAuthFailure } from "../agents/agent-auth-failure.entity";
import { AgentAuthFailuresService } from "../agents/agent-auth-failures.service";
import { AgentConfigPushService } from "../agents/agent-config-push.service";
import { AgentConfigService } from "../agents/agent-config.service";
import { AgentDetailRequestService } from "../agents/agent-detail-request.service";
import { AgentDisconnectService } from "../agents/agent-disconnect.service";
import { AgentEnrollment } from "../agents/agent-enrollment.entity";
import { AgentEnrollmentsService } from "../agents/agent-enrollments.service";
import { AgentExecService } from "../agents/agent-exec.service";
import { AgentFilesService } from "../agents/agent-files.service";
import { AgentIngestService } from "../agents/agent-ingest.service";
import { AgentRegistryService } from "../agents/agent-registry.service";
import {
  AgentReleaseService,
  fileSystemAgentReleases,
} from "../agents/agent-release.service";
import { AgentToken } from "../agents/agent-token.entity";
import { AgentTokensService } from "../agents/agent-tokens.service";
import { AgentUpdateService } from "../agents/agent-update.service";
import { AUDIT } from "../audit/audit.module";
import type { AuditService } from "../audit/audit.service";
import type { AuthService } from "../auth/auth.service";
import { AUTH } from "../auth/auth.module";
import type { ServiceKey, ServiceRegistry } from "../core/services";
import { dataSourceOptions } from "../database/data-source";
import { EVENTS } from "../events/events.module";
import type { EventsService } from "../events/events.service";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { GitBlobBufferService } from "../git/git-blob-buffer.service";
import { GitDetailService } from "../git/git-detail.service";
import { GitIngestService } from "../git/git-ingest.service";
import { GitService } from "../git/git.service";
import { RepoCommit } from "../git/repo-commit.entity";
import { RepoRef } from "../git/repo-ref.entity";
import { Repo } from "../git/repo.entity";
import { HostGitRoot } from "../hosts/host-git-root.entity";
import { HostGitRootsService } from "../hosts/host-git-roots.service";
import { HostService } from "../hosts/host-service.entity";
import { HostServicesService } from "../hosts/host-services.service";
import { Host } from "../hosts/host.entity";
import { HostsService } from "../hosts/hosts.service";
import { StaleHostsService } from "../hosts/stale-hosts.service";
import {
  STALE_HOSTS_CRON,
  STALE_HOSTS_JOB,
  STALE_HOSTS_QUEUE,
} from "../hosts/stale-hosts.queue";
import { redisConnection } from "../jobs/queue";
import { HostMcpKey } from "../mcp/host-mcp-key.entity";
import { HostMcpKeysService } from "../mcp/host-mcp-keys.service";
import { AgentKitController } from "../mcp/agent-kit.controller";
import { McpController } from "../mcp/mcp.controller";
import { McpAuthService } from "../mcp/mcp-auth.service";
import { McpAuthorityService } from "../mcp/mcp-authority.service";
import { UserMcpKey } from "../mcp/user-mcp-key.entity";
import { UserMcpKeysService } from "../mcp/user-mcp-keys.service";
import { HostMetricSample } from "../metrics/host-metric-sample.entity";
import { MetricsRetentionService } from "../metrics/metrics-retention.service";
import {
  METRICS_PRUNE_CRON,
  METRICS_PRUNE_JOB,
  METRICS_QUEUE,
} from "../metrics/metrics.queue";
import { MetricsService } from "../metrics/metrics.service";
import { UserHostPref } from "../prefs/user-host-pref.entity";
import { UserLayout } from "../prefs/user-layout.entity";
import { PrefsService } from "../prefs/prefs.service";
import { STORAGE } from "../storage/storage.module";
import type { StorageService } from "../storage/storage.service";
import { TerminalRelayService } from "../terminal/terminal-relay.service";
import { TerminalMuxController } from "../terminal/terminal-mux.controller";

export interface PdmuxServices {
  dataSource: DataSource;
  auth: AuthService;
  audit: AuditService;
  fleetSettings: FleetSettingsService;
  hosts: HostsService;
  hostServices: HostServicesService;
  hostGitRoots: HostGitRootsService;
  metrics: MetricsService;
  git: GitService;
  gitIngest: GitIngestService;
  agentRegistry: AgentRegistryService;
  agentAck: AgentAckService;
  agentTokens: AgentTokensService;
  agentEnrollments: AgentEnrollmentsService;
  agentAuthFailures: AgentAuthFailuresService;
  agentConfig: AgentConfigService;
  agentIngest: AgentIngestService;
  agentExec: AgentExecService;
  agentFiles: AgentFilesService;
  agentUpdates: AgentUpdateService;
  terminalRelay: TerminalRelayService;
  terminalMux: TerminalMuxController;
  prefs: PrefsService;
  hostMcpKeys: HostMcpKeysService;
  userMcpKeys: UserMcpKeysService;
  mcpAuth: McpAuthService;
  mcp: McpController;
  agentKit: AgentKitController;
  staleHosts: StaleHostsService;
  metricsRetention: MetricsRetentionService;
}

export const PDMUX = Symbol("pdmux") as ServiceKey<PdmuxServices>;
const PDMUX_LIFECYCLE = Symbol("pdmux-lifecycle") as ServiceKey<DataSource>;

async function scheduleMaintenance(staleQueue: Queue, metricsQueue: Queue): Promise<void> {
  await Promise.allSettled([
    staleQueue.add(STALE_HOSTS_JOB, {}, {
      repeat: { pattern: STALE_HOSTS_CRON },
      jobId: STALE_HOSTS_JOB,
      removeOnComplete: true,
      removeOnFail: 20,
    }),
    metricsQueue.add(METRICS_PRUNE_JOB, {}, {
      repeat: { pattern: METRICS_PRUNE_CRON },
      jobId: METRICS_PRUNE_JOB,
      removeOnComplete: true,
      removeOnFail: 20,
    }),
  ]);
}

export function createPdmuxServices(services: ServiceRegistry): PdmuxServices {
  const dataSource = new DataSource(dataSourceOptions);
  const storage: StorageService = services.resolve(STORAGE);
  const events: EventsService = services.resolve(EVENTS);
  const auth = services.resolve(AUTH);
  const audit = services.resolve(AUDIT);

  const fleetSettings = new FleetSettingsService(dataSource.getRepository(FleetSetting));
  const releases = new AgentReleaseService(fileSystemAgentReleases);
  const hosts = new HostsService(
    dataSource.getRepository(Host),
    dataSource.getRepository(HostService),
    dataSource.getRepository(HostGitRoot),
    fleetSettings,
    releases,
    dataSource,
  );
  const hostServices = new HostServicesService(dataSource.getRepository(HostService), hosts);
  const hostGitRoots = new HostGitRootsService(dataSource.getRepository(HostGitRoot), hosts);
  const metrics = new MetricsService(dataSource.getRepository(HostMetricSample));
  const gitDetails = new GitDetailService(storage);
  const gitBlobs = new GitBlobBufferService();
  const git = new GitService(
    dataSource.getRepository(Repo),
    dataSource.getRepository(RepoRef),
    dataSource.getRepository(RepoCommit),
    gitDetails,
    gitBlobs,
    hosts,
  );
  const gitIngest = new GitIngestService(
    dataSource.getRepository(Repo),
    dataSource.getRepository(RepoRef),
    dataSource.getRepository(RepoCommit),
    gitDetails,
    gitBlobs,
  );

  const agentRegistry = new AgentRegistryService();
  const agentAck = new AgentAckService(git, agentRegistry);
  const agentExec = new AgentExecService(agentRegistry, hosts);
  const agentFiles = new AgentFilesService(agentRegistry, hosts);
  const agentConfig = new AgentConfigService(fleetSettings, hostServices, hostGitRoots);
  const disconnect = new AgentDisconnectService(hosts, agentRegistry);
  const agentTokens = new AgentTokensService(dataSource.getRepository(AgentToken), hosts, disconnect);
  const agentEnrollments = new AgentEnrollmentsService(
    dataSource.getRepository(AgentEnrollment),
    hosts,
    agentTokens,
  );
  const agentAuthFailures = new AgentAuthFailuresService(
    dataSource.getRepository(AgentAuthFailure),
    hosts,
  );
  const agentUpdates = new AgentUpdateService(hosts, agentRegistry, releases);
  const agentIngest = new AgentIngestService(
    hosts,
    metrics,
    gitIngest,
    fleetSettings,
    events,
    agentRegistry,
    agentAck,
    agentExec,
    agentFiles,
  );
  const configPush = new AgentConfigPushService(
    fleetSettings,
    hostServices,
    hostGitRoots,
    hosts,
    agentConfig,
    agentRegistry,
  );
  const detailRequests = new AgentDetailRequestService(git, agentRegistry);
  const terminalRelay = new TerminalRelayService(agentRegistry);
  const terminalMux = new TerminalMuxController(agentExec);

  const authority = new McpAuthorityService(dataSource);
  const hostMcpKeys = new HostMcpKeysService(dataSource.getRepository(HostMcpKey), hosts);
  const userMcpKeys = new UserMcpKeysService(dataSource.getRepository(UserMcpKey), authority);
  const mcpAuth = new McpAuthService(hostMcpKeys, userMcpKeys);
  const mcp = new McpController(
    mcpAuth,
    hosts,
    fleetSettings,
    hostServices,
    metrics,
    git,
    agentEnrollments,
    agentExec,
    agentUpdates,
  );
  const agentKit = new AgentKitController();
  const prefs = new PrefsService(
    dataSource.getRepository(UserLayout),
    dataSource.getRepository(UserHostPref),
    hosts,
  );
  const staleHosts = new StaleHostsService(dataSource.getRepository(Host), fleetSettings);
  const metricsRetention = new MetricsRetentionService(
    dataSource.getRepository(Host),
    fleetSettings,
    metrics,
  );

  const staleQueue = new Queue(STALE_HOSTS_QUEUE, { connection: redisConnection() });
  const metricsQueue = new Queue(METRICS_QUEUE, { connection: redisConnection() });
  services.onStart(async () => {
    await dataSource.initialize();
    hosts.setConnectedProbe((hostId) => agentRegistry.isConnected(hostId));
    agentEnrollments.connect();
    disconnect.connect();
    configPush.connect();
    detailRequests.connect();
    terminalRelay.attach();
    await scheduleMaintenance(staleQueue, metricsQueue);
  });
  services.register(
    PDMUX_LIFECYCLE,
    dataSource,
    async () => {
      terminalRelay.detach();
      await Promise.all([staleQueue.close(), metricsQueue.close()]);
      if (dataSource.isInitialized) await dataSource.destroy();
    },
  );

  const result: PdmuxServices = {
    dataSource,
    auth,
    audit,
    fleetSettings,
    hosts,
    hostServices,
    hostGitRoots,
    metrics,
    git,
    gitIngest,
    agentRegistry,
    agentAck,
    agentTokens,
    agentEnrollments,
    agentAuthFailures,
    agentConfig,
    agentIngest,
    agentExec,
    agentFiles,
    agentUpdates,
    terminalRelay,
    terminalMux,
    prefs,
    hostMcpKeys,
    userMcpKeys,
    mcpAuth,
    mcp,
    agentKit,
    staleHosts,
    metricsRetention,
  };
  services.register(PDMUX, result);
  return result;
}
