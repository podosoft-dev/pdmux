import { decryptSecret, encryptSecret } from "@podosoft/podokit-auth";
import { Repository } from "typeorm";
import { AppException } from "../common/app-exception";
import type { HostService } from "../hosts/host-service.entity";
import { HostServicesService } from "../hosts/host-services.service";
import { HostsService } from "../hosts/hosts.service";
import { CloudflareClient, type CloudflareIngress } from "./cloudflare.client";
import type {
  CreateServiceExposureDto,
  PutCloudflareIntegrationDto,
  UpdateServiceExposureDto,
} from "./dto/cloudflare.dto";
import { HostConnector } from "./host-connector.entity";
import {
  IntegrationConnection,
  type CloudflareConnectionConfig,
} from "./integration-connection.entity";
import { ServiceExposure } from "./service-exposure.entity";
import { ProductLogger } from "../logging/product-logger";

export interface CloudflareIntegrationView extends CloudflareConnectionConfig {
  connected: true;
  tokenConfigured: true;
  updatedAt: string;
}

export interface CloudflareDiscovery {
  zones: Array<{ id: string; name: string; accountId: string; accountName: string }>;
  policies: Array<{ id: string; name: string; accountId: string }>;
}

export interface ServiceExposureView {
  id: string;
  serviceId: string;
  provider: "cloudflare";
  hostname: string;
  url: string;
  mode: "access" | "public";
  originScheme: "http" | "https";
  noTlsVerify: boolean;
  status: "pending" | "protected" | "public" | "error";
  errorCode: string | null;
  connector: { state: string; version: string | null; errorCode: string | null } | null;
}

export type CloudflareConfigChangeListener = (hostId: string, organizationId: string) => Promise<void> | void;

type ClientFactory = (token: string) => CloudflareClient;

function slug(value: string, fallback: string): string {
  const clean = value.toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return clean || fallback;
}

/** Coordinates Cloudflare resources and commits local state only after activation succeeds. */
export class CloudflareService {
  private readonly logger = new ProductLogger(CloudflareService.name);
  private changeListener: CloudflareConfigChangeListener = () => {};

  constructor(
    private readonly connections: Repository<IntegrationConnection>,
    private readonly connectors: Repository<HostConnector>,
    private readonly exposures: Repository<ServiceExposure>,
    private readonly hosts: HostsService,
    private readonly hostServices: HostServicesService,
    private readonly clientFactory: ClientFactory = (token) => new CloudflareClient(token),
  ) {}

  setChangeListener(listener: CloudflareConfigChangeListener): void {
    this.changeListener = listener;
  }

  connect(): void {
    this.hostServices.setUpdatingListener((current, next, organizationId) =>
      this.prepareServiceUpdate(current, next, organizationId),
    );
    this.hostServices.setRemovingListener((hostId, serviceId, organizationId) =>
      this.removeForService(organizationId, hostId, serviceId),
    );
    this.hosts.setRemovingListener((hostId, organizationId) =>
      this.removeForHost(organizationId, hostId),
    );
    this.hosts.setMovingListener((hostId, organizationId) =>
      this.assertHostMoveAllowed(organizationId, hostId),
    );
  }

  async discover(apiToken: string): Promise<CloudflareDiscovery> {
    const client = this.clientFactory(apiToken);
    const zones = await client.zones();
    const accountIds = [...new Set(zones.map((zone) => zone.accountId))];
    const policies = (await Promise.all(accountIds.map((id) => client.policies(id)))).flat();
    return { zones, policies };
  }

  async get(organizationId: string): Promise<CloudflareIntegrationView | null> {
    const row = await this.connection(organizationId);
    return row ? this.connectionView(row) : null;
  }

  async put(organizationId: string, input: PutCloudflareIntegrationDto): Promise<CloudflareIntegrationView> {
    const discovery = await this.discover(input.apiToken);
    const zone = discovery.zones.find((candidate) => candidate.id === input.zoneId);
    if (!zone) throw new AppException("CLOUDFLARE_ZONE_INVALID", "The selected zone is unavailable", 400);
    if (input.baseDomain !== zone.name && !input.baseDomain.endsWith(`.${zone.name}`)) {
      throw new AppException("CLOUDFLARE_DOMAIN_INVALID", "The base domain must belong to the selected zone", 400);
    }
    const policy = discovery.policies.find(
      (candidate) => candidate.id === input.accessPolicyId && candidate.accountId === zone.accountId,
    );
    if (!policy) throw new AppException("CLOUDFLARE_POLICY_INVALID", "The selected Access policy is unavailable", 400);

    const current = await this.connection(organizationId);
    if (current && (
      await this.exposures.count({ where: { integrationId: current.id } }) > 0
      || await this.connectors.count({ where: { integrationId: current.id } }) > 0
    )) {
      throw new AppException(
        "CLOUDFLARE_IN_USE",
        "Remove active service exposures before changing the Cloudflare connection",
        409,
      );
    }
    const config: CloudflareConnectionConfig = {
      accountId: zone.accountId,
      zoneId: zone.id,
      zoneName: zone.name,
      baseDomain: input.baseDomain,
      accessPolicyId: policy.id,
      accessPolicyName: policy.name,
    };
    const saved = await this.connections.save(this.connections.create({
      ...(current ?? {}),
      organizationId,
      provider: "cloudflare",
      config,
      secret: encryptSecret(input.apiToken),
      enabled: true,
    }));
    return this.connectionView(saved);
  }

  async removeConnection(organizationId: string): Promise<{ disconnected: true }> {
    const row = await this.requiredConnection(organizationId);
    if (await this.exposures.count({ where: { integrationId: row.id } }) > 0) {
      throw new AppException("CLOUDFLARE_IN_USE", "Remove active service exposures first", 409);
    }
    const connectors = await this.connectors.find({ where: { integrationId: row.id } });
    const client = this.client(row);
    for (const connector of connectors) await client.deleteTunnel(row.config.accountId, connector.externalId);
    await this.connectors.delete({ integrationId: row.id });
    await this.connections.delete({ id: row.id });
    return { disconnected: true };
  }

  async listForHost(organizationId: string, hostId: string): Promise<ServiceExposureView[]> {
    await this.hosts.get(organizationId, hostId);
    const rows = await this.exposures.find({ where: { organizationId, hostId, provider: "cloudflare" } });
    const connectorStatus = await this.connectorStatus(hostId);
    return rows.map((row) => this.exposureView(row, connectorStatus));
  }

  async createExposure(
    organizationId: string,
    hostId: string,
    serviceId: string,
    input: CreateServiceExposureDto,
  ): Promise<ServiceExposureView> {
    const host = await this.hosts.get(organizationId, hostId);
    if (host.connectorCapabilities?.cloudflared !== true) {
      throw new AppException("CLOUDFLARED_AGENT_REQUIRED", "Update and connect this host's agent first", 409);
    }
    const service = await this.hostServices.get(organizationId, hostId, serviceId);
    this.assertExposureInput(input);
    const connection = await this.requiredConnection(organizationId);
    this.assertHostname(connection.config, input.hostname);
    const duplicate = await this.exposures.findOne({ where: { serviceId, provider: "cloudflare" } });
    if (duplicate) throw new AppException("SERVICE_ALREADY_EXPOSED", "The service already has an exposure", 409);

    const client = this.client(connection);
    const { connector, created } = await this.ensureConnector(connection, host.id, host.label, client);
    let accessAppId: string | null = null;
    let dnsRecordId: string | null = null;
    let pending: ServiceExposure | null = null;
    let ingressAttempted = false;
    try {
      if (input.mode === "access") {
        accessAppId = await client.createAccessApp(
          connection.config.accountId,
          input.hostname,
          connection.config.accessPolicyId,
        );
      }
      const row = this.exposures.create({
        integrationId: connection.id,
        connectorId: connector.id,
        organizationId,
        hostId,
        serviceId,
        provider: "cloudflare",
        hostname: input.hostname,
        mode: input.mode,
        originScheme: input.originScheme,
        noTlsVerify: input.noTlsVerify ?? false,
        status: input.mode === "access" ? "protected" : "public",
        externalDnsRecordId: null,
        externalAccessAppId: accessAppId,
        errorCode: null,
      });
      pending = row;
      ingressAttempted = true;
      await this.putIngress(connection, connector, [...await this.routeRows(hostId), { row, service }], client);
      // DNS is last: a hostname never points at a route before its Access policy and
      // origin ingress exist.
      dnsRecordId = await client.createDns(connection.config.zoneId, input.hostname, connector.externalId);
      row.externalDnsRecordId = dnsRecordId;
      const saved = await this.exposures.save(row);
      await this.notify(hostId, organizationId);
      return this.exposureView(saved, await this.connectorStatus(hostId));
    } catch (error) {
      let cleanupIncomplete = false;
      if (dnsRecordId) {
        const removed = await client.deleteDns(connection.config.zoneId, dnsRecordId)
          .then(() => true)
          .catch(() => false);
        if (removed) dnsRecordId = null;
        else cleanupIncomplete = true;
      }
      if (accessAppId) {
        const removed = await client.deleteAccessApp(connection.config.accountId, accessAppId)
          .then(() => true)
          .catch(() => false);
        if (removed) accessAppId = null;
        else cleanupIncomplete = true;
      }
      if (ingressAttempted) {
        const restored = await this.putIngress(connection, connector, await this.routeRows(hostId), client)
          .then(() => true)
          .catch(() => false);
        if (!restored) cleanupIncomplete = true;
      }
      if (cleanupIncomplete && pending) {
        // A failed compensating delete is still managed state. Persist every
        // identifier we know so the normal removal path can retry it instead of
        // abandoning an Access app, DNS record, or tunnel outside pdmux.
        pending.externalDnsRecordId = dnsRecordId;
        pending.externalAccessAppId = accessAppId;
        pending.status = "error";
        pending.errorCode = "CLOUDFLARE_CLEANUP_REQUIRED";
        try {
          await this.exposures.save(pending);
          await this.notify(hostId, organizationId);
        } catch (persistenceError) {
          this.logger.error(
            `Cloudflare cleanup state could not be retained host=${hostId}: ${String(persistenceError)}`,
          );
        }
      } else if (created) {
        // Keep the encrypted token row when provider cleanup fails. A later
        // disconnect can then retry deleting the known tunnel instead of losing
        // its only local identifier and leaving an unmanaged external resource.
        const removed = await client.deleteTunnel(connection.config.accountId, connector.externalId)
          .then(() => true)
          .catch(() => false);
        if (removed) await this.connectors.delete({ id: connector.id });
      }
      throw error;
    }
  }

  async updateExposure(
    organizationId: string,
    hostId: string,
    serviceId: string,
    exposureId: string,
    input: UpdateServiceExposureDto,
  ): Promise<ServiceExposureView> {
    this.assertExposureInput(input);
    const row = await this.requiredExposure(organizationId, hostId, serviceId, exposureId);
    const connection = await this.requiredConnection(organizationId);
    this.assertHostname(connection.config, input.hostname);
    const service = await this.hostServices.get(organizationId, hostId, serviceId);
    const connector = await this.connectors.findOne({ where: { id: row.connectorId, hostId } });
    if (!connector) throw new AppException("CLOUDFLARE_CONNECTOR_MISSING", "The host connector is missing", 409);
    const client = this.client(connection);
    const hostnameChanged = row.hostname !== input.hostname;
    const others = (await this.routeRows(hostId)).filter(({ row: candidate }) => candidate.id !== row.id);
    let nextAccessId = row.externalAccessAppId;
    let nextDnsId = row.externalDnsRecordId;
    let createdAccessId: string | null = null;
    let createdDnsId: string | null = null;
    let removedOldAccess = false;
    let removedOldDns = false;

    try {
      if (input.mode === "access" && (row.mode !== "access" || hostnameChanged)) {
        createdAccessId = await client.createAccessApp(
          connection.config.accountId,
          input.hostname,
          connection.config.accessPolicyId,
        );
        nextAccessId = createdAccessId;
      }
      const next = this.exposures.create({
        ...row,
        hostname: input.hostname,
        mode: input.mode,
        originScheme: input.originScheme,
        noTlsVerify: input.noTlsVerify ?? false,
        status: input.mode === "access" ? "protected" : "public",
        externalAccessAppId: input.mode === "access" ? nextAccessId : null,
        errorCode: null,
      });
      await this.putIngress(connection, connector, [...others, { row: next, service }], client);
      if (hostnameChanged) {
        createdDnsId = await client.createDns(connection.config.zoneId, next.hostname, connector.externalId);
        nextDnsId = createdDnsId;
      }

      // Only retire the old entry points after the replacement policy, ingress,
      // and DNS are all live. The catch block can reconstruct either identifier
      // if a later provider operation or the database save fails.
      if (hostnameChanged && row.externalDnsRecordId) {
        await client.deleteDns(connection.config.zoneId, row.externalDnsRecordId);
        removedOldDns = true;
      }
      if (row.externalAccessAppId && row.externalAccessAppId !== next.externalAccessAppId) {
        await client.deleteAccessApp(connection.config.accountId, row.externalAccessAppId);
        removedOldAccess = true;
      }
      next.externalDnsRecordId = nextDnsId;
      const saved = await this.exposures.save(next);
      await this.notify(hostId, organizationId);
      return this.exposureView(saved, await this.connectorStatus(hostId));
    } catch (error) {
      await this.rollbackUpdate({
        connection,
        connector,
        row,
        service,
        others,
        client,
        createdAccessId,
        createdDnsId,
        removedOldAccess,
        removedOldDns,
      });
      throw error;
    }
  }

  async removeExposure(
    organizationId: string,
    hostId: string,
    serviceId: string,
    exposureId: string,
  ): Promise<{ id: string; hostname: string }> {
    const row = await this.requiredExposure(organizationId, hostId, serviceId, exposureId);
    const connection = await this.requiredConnection(organizationId);
    const connector = await this.connectors.findOne({ where: { id: row.connectorId, hostId } });
    if (!connector) throw new AppException("CLOUDFLARE_CONNECTOR_MISSING", "The host connector is missing", 409);
    const client = this.client(connection);
    // DNS is first on teardown, so a hostname stops accepting traffic before its
    // protection and route are removed.
    if (row.externalDnsRecordId) await client.deleteDns(connection.config.zoneId, row.externalDnsRecordId);
    const remaining = (await this.routeRows(hostId)).filter(({ row: candidate }) => candidate.id !== row.id);
    await this.putIngress(connection, connector, remaining, client);
    if (row.externalAccessAppId) {
      await client.deleteAccessApp(connection.config.accountId, row.externalAccessAppId);
    }
    // Delete the dedicated tunnel before its last local exposure and connector.
    // If provider cleanup fails, the retained rows keep every identifier needed
    // for an idempotent retry from service or host deletion.
    if (remaining.length === 0) {
      await client.deleteTunnel(connection.config.accountId, connector.externalId);
    }
    await this.exposures.delete({ id: row.id });
    if (remaining.length === 0) {
      await this.connectors.delete({ id: connector.id });
    }
    await this.notify(hostId, organizationId);
    return { id: row.id, hostname: row.hostname };
  }

  async removeForService(organizationId: string, hostId: string, serviceId: string): Promise<void> {
    const row = await this.exposures.findOne({ where: { organizationId, hostId, serviceId, provider: "cloudflare" } });
    if (row) await this.removeExposure(organizationId, hostId, serviceId, row.id);
  }

  async removeForHost(organizationId: string, hostId: string): Promise<void> {
    const rows = await this.exposures.find({ where: { organizationId, hostId, provider: "cloudflare" } });
    for (const row of rows) await this.removeExposure(organizationId, hostId, row.serviceId, row.id);
  }

  async assertHostMoveAllowed(organizationId: string, hostId: string): Promise<void> {
    const [exposureCount, connectorCount] = await Promise.all([
      this.exposures.count({ where: { organizationId, hostId, provider: "cloudflare" } }),
      this.connectors.count({ where: { organizationId, hostId, provider: "cloudflare" } }),
    ]);
    if (exposureCount > 0 || connectorCount > 0) {
      throw new AppException(
        "HOST_EXTERNAL_ACCESS_ACTIVE",
        "Remove this host's external access before moving it",
        409,
      );
    }
  }

  async prepareServiceUpdate(
    current: HostService,
    next: HostService,
    organizationId: string,
  ): Promise<(() => Promise<void>) | void> {
    if (current.port === next.port) return;
    const exposure = await this.exposures.findOne({
      where: { organizationId, hostId: current.hostId, serviceId: current.id, provider: "cloudflare" },
    });
    if (!exposure) return;
    const connection = await this.requiredConnection(organizationId);
    const connector = await this.connectors.findOne({
      where: { id: exposure.connectorId, hostId: current.hostId, provider: "cloudflare" },
    });
    if (!connector) {
      throw new AppException("CLOUDFLARE_CONNECTOR_MISSING", "The host connector is missing", 409);
    }
    const client = this.client(connection);
    const routes = await this.routeRows(current.hostId);
    const withNextPort = routes.map((route) =>
      route.row.serviceId === current.id ? { row: route.row, service: next } : route,
    );
    await this.putIngress(connection, connector, withNextPort, client);
    return async (): Promise<void> => {
      const restored = (await this.routeRows(current.hostId)).map((route) =>
        route.row.serviceId === current.id ? { row: route.row, service: current } : route,
      );
      await this.putIngress(connection, connector, restored, client);
    };
  }

  async agentConnector(hostId: string): Promise<{ enabled: boolean; token: string; checkIntervalSec: number }> {
    const connector = await this.connectors.findOne({ where: { hostId, provider: "cloudflare" } });
    if (!connector || await this.exposures.count({ where: { connectorId: connector.id } }) === 0) {
      return { enabled: false, token: "", checkIntervalSec: 86_400 };
    }
    return { enabled: true, token: decryptSecret(connector.secret), checkIntervalSec: 86_400 };
  }

  suggestion(baseDomain: string, hostLabel: string, serviceLabel: string, hostId: string, serviceId: string): string {
    return `${slug(serviceLabel, serviceId.slice(0, 8))}-${slug(hostLabel, hostId.slice(0, 8))}.${baseDomain}`;
  }

  private async routeRows(hostId: string): Promise<Array<{ row: ServiceExposure; service: HostService }>> {
    const rows = await this.exposures.find({ where: { hostId, provider: "cloudflare" } });
    const services = await this.hostServices.listForHost(hostId);
    const byId = new Map(services.map((service) => [service.id, service]));
    return rows.flatMap((row) => {
      const service = byId.get(row.serviceId);
      return service ? [{ row, service }] : [];
    });
  }

  private async putIngress(
    connection: IntegrationConnection,
    connector: HostConnector,
    routes: Array<{ row: ServiceExposure; service: HostService }>,
    client: CloudflareClient,
  ): Promise<void> {
    const ingress: CloudflareIngress[] = routes.map(({ row, service }) => ({
      hostname: row.hostname,
      service: `${row.originScheme}://127.0.0.1:${service.port}`,
      ...(row.originScheme === "https" && row.noTlsVerify
        ? { originRequest: { noTLSVerify: true } }
        : {}),
    }));
    await client.putIngress(connection.config.accountId, connector.externalId, ingress);
  }

  private async rollbackUpdate(input: {
    connection: IntegrationConnection;
    connector: HostConnector;
    row: ServiceExposure;
    service: HostService;
    others: Array<{ row: ServiceExposure; service: HostService }>;
    client: CloudflareClient;
    createdAccessId: string | null;
    createdDnsId: string | null;
    removedOldAccess: boolean;
    removedOldDns: boolean;
  }): Promise<void> {
    const {
      connection,
      connector,
      row,
      service,
      others,
      client,
      createdAccessId,
      createdDnsId,
      removedOldAccess,
      removedOldDns,
    } = input;
    const failures: unknown[] = [];
    const attempt = async (operation: () => Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };

    if (createdDnsId) {
      await attempt(() => client.deleteDns(connection.config.zoneId, createdDnsId));
    }
    await attempt(() => this.putIngress(connection, connector, [...others, { row, service }], client));
    if (createdAccessId) {
      await attempt(() => client.deleteAccessApp(connection.config.accountId, createdAccessId));
    }
    if (removedOldAccess && row.mode === "access") {
      try {
        row.externalAccessAppId = await client.createAccessApp(
          connection.config.accountId,
          row.hostname,
          connection.config.accessPolicyId,
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (removedOldDns) {
      try {
        row.externalDnsRecordId = await client.createDns(
          connection.config.zoneId,
          row.hostname,
          connector.externalId,
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (removedOldAccess || removedOldDns) {
      await attempt(async () => {
        await this.exposures.save(row);
      });
    }
    if (failures.length > 0) {
      this.logger.warn(`Cloudflare exposure rollback was incomplete exposure=${row.id} failures=${failures.length}`);
    }
  }

  private async ensureConnector(
    connection: IntegrationConnection,
    hostId: string,
    hostLabel: string,
    client: CloudflareClient,
  ): Promise<{ connector: HostConnector; created: boolean }> {
    const current = await this.connectors.findOne({ where: { hostId, provider: "cloudflare" } });
    if (current) return { connector: current, created: false };
    const name = `pdmux-${slug(hostLabel, hostId.slice(0, 8))}-${hostId.slice(0, 8)}`.slice(0, 100);
    const tunnel = await client.createTunnel(connection.config.accountId, name);
    try {
      const connector = await this.connectors.save(this.connectors.create({
        integrationId: connection.id,
        organizationId: connection.organizationId,
        hostId,
        provider: "cloudflare",
        externalId: tunnel.id,
        name,
        secret: encryptSecret(tunnel.token),
      }));
      return { connector, created: true };
    } catch (error) {
      await client.deleteTunnel(connection.config.accountId, tunnel.id).catch(() => {});
      throw error;
    }
  }

  private async connectorStatus(hostId: string): Promise<ServiceExposureView["connector"]> {
    const host = await this.hosts.getById(hostId);
    const cloudflared = host?.lastHeartbeat?.cloudflared;
    return cloudflared
      ? { state: cloudflared.state, version: cloudflared.version, errorCode: cloudflared.errorCode }
      : null;
  }

  private exposureView(row: ServiceExposure, connector: ServiceExposureView["connector"]): ServiceExposureView {
    return {
      id: row.id,
      serviceId: row.serviceId,
      provider: "cloudflare",
      hostname: row.hostname,
      url: `https://${row.hostname}`,
      mode: row.mode,
      originScheme: row.originScheme,
      noTlsVerify: row.noTlsVerify,
      status: row.status,
      errorCode: row.errorCode,
      connector,
    };
  }

  private connectionView(row: IntegrationConnection): CloudflareIntegrationView {
    return { ...row.config, connected: true, tokenConfigured: true, updatedAt: row.updatedAt.toISOString() };
  }

  private client(row: IntegrationConnection): CloudflareClient {
    return this.clientFactory(decryptSecret(row.secret));
  }

  private connection(organizationId: string): Promise<IntegrationConnection | null> {
    return this.connections.findOne({ where: { organizationId, provider: "cloudflare", enabled: true } });
  }

  private async requiredConnection(organizationId: string): Promise<IntegrationConnection> {
    const row = await this.connection(organizationId);
    if (!row) throw new AppException("CLOUDFLARE_NOT_CONNECTED", "Cloudflare is not connected", 409);
    return row;
  }

  private async requiredExposure(
    organizationId: string,
    hostId: string,
    serviceId: string,
    id: string,
  ): Promise<ServiceExposure> {
    await this.hosts.get(organizationId, hostId);
    const row = await this.exposures.findOne({ where: { id, organizationId, hostId, serviceId, provider: "cloudflare" } });
    if (!row) throw new AppException("SERVICE_EXPOSURE_NOT_FOUND", "Service exposure not found", 404);
    return row;
  }

  private assertExposureInput(input: CreateServiceExposureDto): void {
    if (input.mode === "public" && input.confirmPublic !== true) {
      throw new AppException("PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED", "Public exposure requires confirmation", 400);
    }
    if (input.originScheme === "http" && input.noTlsVerify === true) {
      throw new AppException("ORIGIN_TLS_OPTION_INVALID", "TLS verification applies only to HTTPS origins", 400);
    }
  }

  private assertHostname(config: CloudflareConnectionConfig, hostname: string): void {
    if (hostname === config.baseDomain || !hostname.endsWith(`.${config.baseDomain}`)) {
      throw new AppException("CLOUDFLARE_HOSTNAME_INVALID", "The hostname must be below the configured base domain", 400);
    }
  }

  private async notify(hostId: string, organizationId: string): Promise<void> {
    try {
      await this.changeListener(hostId, organizationId);
    } catch (error) {
      // Provider state and the database have already committed. A socket that
      // vanished during the push picks up the same config on its next welcome.
      this.logger.warn(`Config push after a Cloudflare change failed host=${hostId}: ${String(error)}`);
    }
  }
}
