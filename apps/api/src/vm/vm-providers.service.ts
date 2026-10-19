import { X509Certificate } from "node:crypto";
import { decryptSecret, encryptSecret } from "@podosoft/podokit-auth";
import { IsNull, LessThan, type Repository } from "typeorm";
import { AppException } from "../common/app-exception";
import { HostVm } from "./host-vm.entity";
import { ProxmoxDriver } from "./proxmox/proxmox.driver";
import type { VmCatalog, VmDriverFactory, VmProviderConfig, VmProviderDriver, VmProviderKind, VmRef } from "./vm-provider";
import { VmProvider } from "./vm-provider.entity";

/** What a screen may know about a provider. The credential is never in it. */
export interface VmProviderView {
  id: string;
  kind: VmProviderKind;
  name: string;
  baseUrl: string;
  tokenId: string;
  /** SHA-256 of the trusted CA, so a person can compare it with the one on the server. */
  caFingerprint: string | null;
  defaults: VmProviderConfig["defaults"];
  sleepRequiresTag: string | null;
  backupBeforeSleep: string | null;
  enrollUrl: string | null;
  lastTestedAt: string | null;
  lastErrorCode: string | null;
  machineCount: number;
}

export interface VmProviderInput {
  kind: VmProviderKind;
  name: string;
  baseUrl: string;
  tokenId: string;
  tokenSecret: string;
  caCertificate: string | null;
  defaultNode: string | null;
  defaultTemplate: VmRef | null;
  defaultStorage: string | null;
  defaultPool: string | null;
  vmidMin: number;
  vmidMax: number;
  defaultCores: number;
  defaultMemoryMb: number;
  fullClone: boolean;
  sleepRequiresTag: string | null;
  backupBeforeSleep: string | null;
  enrollUrl: string | null;
}

export const defaultDriverFactory: VmDriverFactory = (kind, config, secret) => {
  if (kind === "proxmox") return ProxmoxDriver.create(config, secret);
  throw new AppException("VM_PROVIDER_KIND_UNSUPPORTED", "This provider kind is not supported", 400);
};

/** SHA-256 fingerprint of a PEM certificate, in the colon form Proxmox shows. */
export function certificateFingerprint(pem: string): string {
  try {
    return new X509Certificate(pem).fingerprint256;
  } catch {
    throw new AppException("VM_PROVIDER_CA_INVALID", "The CA certificate is not a readable PEM certificate", 400);
  }
}

function configOf(input: VmProviderInput): VmProviderConfig {
  if (input.vmidMin > input.vmidMax) {
    throw new AppException("VM_PROVIDER_VMID_RANGE_INVALID", "The id range is empty", 400);
  }
  if (input.caCertificate) certificateFingerprint(input.caCertificate);
  return {
    baseUrl: input.baseUrl,
    tokenId: input.tokenId,
    caCertificate: input.caCertificate,
    defaults: {
      node: input.defaultNode,
      template: input.defaultTemplate,
      storage: input.defaultStorage,
      pool: input.defaultPool,
      vmidMin: input.vmidMin,
      vmidMax: input.vmidMax,
      cores: input.defaultCores,
      memoryMb: input.defaultMemoryMb,
      fullClone: input.fullClone,
    },
    sleepRequiresTag: input.sleepRequiresTag,
    backupBeforeSleep: input.backupBeforeSleep,
    enrollUrl: input.enrollUrl,
  };
}

function inputOf(row: VmProvider): VmProviderInput {
  const { config } = row;
  return {
    kind: row.kind,
    name: row.name,
    baseUrl: config.baseUrl,
    tokenId: config.tokenId,
    tokenSecret: "",
    caCertificate: config.caCertificate,
    defaultNode: config.defaults.node,
    defaultTemplate: config.defaults.template,
    defaultStorage: config.defaults.storage,
    defaultPool: config.defaults.pool,
    vmidMin: config.defaults.vmidMin,
    vmidMax: config.defaults.vmidMax,
    defaultCores: config.defaults.cores,
    defaultMemoryMb: config.defaults.memoryMb,
    fullClone: config.defaults.fullClone,
    sleepRequiresTag: config.sleepRequiresTag,
    backupBeforeSleep: config.backupBeforeSleep,
    enrollUrl: config.enrollUrl ?? null,
  };
}

/**
 * Fleet-scoped VM provider connections.
 *
 * A connection is saved only after its credentials reached the provider, so a typo in a token
 * is a refusal on the form and not a provider that fails on the first power change.
 */
export class VmProvidersService {
  constructor(
    private readonly providers: Repository<VmProvider>,
    private readonly machines: Repository<HostVm>,
    private readonly driverFactory: VmDriverFactory = defaultDriverFactory,
  ) {}

  async list(organizationId: string): Promise<VmProviderView[]> {
    const rows = await this.providers.find({ where: { organizationId }, order: { name: "ASC" } });
    return Promise.all(rows.map((row) => this.view(row)));
  }

  async get(organizationId: string, id: string): Promise<VmProviderView> {
    return this.view(await this.row(organizationId, id));
  }

  async create(organizationId: string, input: VmProviderInput): Promise<VmProviderView> {
    if (await this.providers.findOne({ where: { organizationId, name: input.name } })) {
      throw new AppException("VM_PROVIDER_NAME_TAKEN", "A provider with this name already exists", 409);
    }
    const config = configOf(input);
    await this.driverFactory(input.kind, config, input.tokenSecret).test();
    const row = await this.providers.save(this.providers.create({
      organizationId,
      kind: input.kind,
      name: input.name,
      config,
      secret: encryptSecret(input.tokenSecret),
      lastTestedAt: new Date(),
      lastErrorCode: null,
      reconcileLeaseUntil: null,
    }));
    return this.view(row);
  }

  /** A blank `tokenSecret` keeps the stored one: the screen never had it to send back. */
  async update(organizationId: string, id: string, patch: Partial<VmProviderInput>): Promise<VmProviderView> {
    const row = await this.row(organizationId, id);
    const merged: VmProviderInput = { ...inputOf(row), ...patch, kind: row.kind };
    if (merged.name !== row.name && await this.providers.findOne({ where: { organizationId, name: merged.name } })) {
      throw new AppException("VM_PROVIDER_NAME_TAKEN", "A provider with this name already exists", 409);
    }
    const secret = patch.tokenSecret ? patch.tokenSecret : decryptSecret(row.secret);
    const config = configOf(merged);
    const reachChanged = config.baseUrl !== row.config.baseUrl || config.tokenId !== row.config.tokenId
      || config.caCertificate !== row.config.caCertificate || Boolean(patch.tokenSecret);
    if (reachChanged) await this.driverFactory(row.kind, config, secret).test();
    row.name = merged.name;
    row.config = config;
    if (patch.tokenSecret) row.secret = encryptSecret(patch.tokenSecret);
    if (reachChanged) {
      row.lastTestedAt = new Date();
      row.lastErrorCode = null;
    }
    return this.view(await this.providers.save(row));
  }

  async remove(organizationId: string, id: string): Promise<{ id: string; name: string }> {
    const row = await this.row(organizationId, id);
    if (await this.machines.count({ where: { providerId: row.id } }) > 0) {
      throw new AppException("VM_PROVIDER_IN_USE", "Machines are still linked to this provider", 409);
    }
    await this.providers.delete({ id: row.id });
    return { id: row.id, name: row.name };
  }

  /** Reach the provider now and remember the answer for the settings screen. */
  async test(organizationId: string, id: string): Promise<VmProviderView> {
    const row = await this.row(organizationId, id);
    try {
      await this.driver(row).test();
      row.lastErrorCode = null;
    } catch (error) {
      row.lastErrorCode = error instanceof AppException ? error.code : "VM_PROVIDER_UNAVAILABLE";
    }
    row.lastTestedAt = new Date();
    return this.view(await this.providers.save(row));
  }

  async discover(organizationId: string, id: string): Promise<VmCatalog> {
    return this.driver(await this.row(organizationId, id)).discover();
  }

  async row(organizationId: string, id: string): Promise<VmProvider> {
    const row = await this.providers.findOne({ where: { id, organizationId } });
    if (!row) throw new AppException("VM_PROVIDER_NOT_FOUND", "VM provider not found", 404);
    return row;
  }

  /** Every provider in every scope — the reconcile's list, never a request's. */
  allRows(): Promise<VmProvider[]> {
    return this.providers.find();
  }

  /**
   * Take this provider's reconcile for a while, if nobody holds it.
   *
   * Two API replicas would otherwise both read the provider every minute and both write what
   * they saw. A conditional write decides who does it; the lease runs out on its own, so a
   * replica that died does not keep it.
   */
  async claimLease(id: string, now: Date, until: Date): Promise<boolean> {
    const free = await this.providers.update({ id, reconcileLeaseUntil: IsNull() }, { reconcileLeaseUntil: until });
    if ((free.affected ?? 0) > 0) return true;
    const expired = await this.providers.update({ id, reconcileLeaseUntil: LessThan(now) }, { reconcileLeaseUntil: until });
    return (expired.affected ?? 0) > 0;
  }

  driver(row: VmProvider): VmProviderDriver {
    return this.driverFactory(row.kind, row.config, decryptSecret(row.secret));
  }

  private async view(row: VmProvider): Promise<VmProviderView> {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      baseUrl: row.config.baseUrl,
      tokenId: row.config.tokenId,
      caFingerprint: row.config.caCertificate ? certificateFingerprint(row.config.caCertificate) : null,
      defaults: row.config.defaults,
      sleepRequiresTag: row.config.sleepRequiresTag,
      backupBeforeSleep: row.config.backupBeforeSleep,
      enrollUrl: row.config.enrollUrl ?? null,
      lastTestedAt: row.lastTestedAt ? row.lastTestedAt.toISOString() : null,
      lastErrorCode: row.lastErrorCode,
      machineCount: await this.machines.count({ where: { providerId: row.id } }),
    };
  }
}
