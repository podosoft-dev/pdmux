import { FleetSetting } from "../../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../../fleet/fleet-settings.service";
import { HostGitRoot } from "../../hosts/host-git-root.entity";
import { HostService } from "../../hosts/host-service.entity";
import { Host } from "../../hosts/host.entity";
import { HostsService } from "../../hosts/hosts.service";
import type { HostEvent, HostEvents } from "../../pdmux/host-events";
import { fakeAgentReleases } from "../../testing/fake-agent-releases";
import { fakeDataSource } from "../../testing/fake-data-source";
import { FakeRepository } from "../../testing/fake-repository";
import { HostVm } from "../host-vm.entity";
import { HostVmsService } from "../host-vms.service";
import type { AuditEntry } from "../../audit/audit-events";
import { VmLifecycleService, type VmEnrollment } from "../vm-lifecycle.service";
import { VmOperationsService } from "../vm-operations.service";
import type { VmProviderKind } from "../vm-provider";
import { VmProvider } from "../vm-provider.entity";
import { VmProvidersService, type VmProviderInput } from "../vm-providers.service";
import { FakeDriver } from "./fake-driver";

export const ORG = "org-a";
export const OTHER_ORG = "org-b";

export interface VmHarness {
  driver: FakeDriver;
  hosts: HostsService;
  hostRows: FakeRepository<Host>;
  providerRows: FakeRepository<VmProvider>;
  machineRows: FakeRepository<HostVm>;
  providers: VmProvidersService;
  machines: HostVmsService;
  published: HostEvent[];
  factorySecrets: string[];
  operations: VmOperationsService;
  audits: AuditEntry[];
  /** The fake clock the operations read; `sleep` advances it unless `paused` (then it really waits). */
  clock: { now: number; paused: boolean };
  enrollment: FakeEnrollment;
  lifecycle: VmLifecycleService;
}

/** The server address a created machine is told when its provider names none. */
export const SERVER_URL = "https://pdmux.example.test";

/**
 * Enrollment codes as the enrollments service hands them out: one live code per host, 15
 * minutes on the harness clock. A machine "enrolls" at once unless `autoEnroll` is off.
 */
export class FakeEnrollment implements VmEnrollment {
  readonly minted: { hostId: string; code: string; actorId: string | null }[] = [];
  readonly enrolled = new Set<string>();
  autoEnroll = true;
  private readonly mintedAt = new Map<string, number>();

  constructor(private readonly clock: { now: number }) {}

  async mint(_organizationId: string, hostId: string, actorId: string | null): Promise<{ code: string }> {
    const code = `code-${this.minted.length + 1}-for-test`;
    this.minted.push({ hostId, code, actorId });
    this.mintedAt.set(hostId, this.clock.now);
    this.enrolled.delete(hostId);
    if (this.autoEnroll) this.enrolled.add(hostId);
    return { code };
  }

  async state(_organizationId: string, hostId: string): Promise<"enrolled" | "waiting" | "expired"> {
    if (this.enrolled.has(hostId)) return "enrolled";
    const at = this.mintedAt.get(hostId);
    return at !== undefined && this.clock.now - at > 15 * 60_000 ? "expired" : "waiting";
  }
}

export function providerInput(overrides: Partial<VmProviderInput> = {}): VmProviderInput {
  return {
    kind: "proxmox",
    name: "lab",
    baseUrl: "https://pve.example.test:8006",
    tokenId: "pdmux@pve!vm-provider",
    tokenSecret: "provider-secret-for-test",
    caCertificate: null,
    defaultNode: "n1",
    defaultTemplate: { node: "n1", vmid: 9001 },
    defaultStorage: "local-lvm",
    defaultPool: "pdmux",
    vmidMin: 500,
    vmidMax: 519,
    defaultCores: 2,
    defaultMemoryMb: 2048,
    fullClone: false,
    sleepRequiresTag: null,
    backupBeforeSleep: null,
    enrollUrl: null,
    ...overrides,
  };
}

export function vmHarness(): VmHarness {
  const driver = new FakeDriver();
  const factorySecrets: string[] = [];
  const hostRows = new FakeRepository<Host>({ tags: [], capabilities: [], sortOrder: 0, enabled: true });
  const settings = new FleetSettingsService(new FakeRepository<FleetSetting>().asRepository());
  const hosts = new HostsService(
    hostRows.asRepository(),
    new FakeRepository<HostService>().asRepository(),
    new FakeRepository<HostGitRoot>().asRepository(),
    settings,
    fakeAgentReleases(),
    fakeDataSource(),
  );
  const stamp = { createdAt: new Date("2026-10-19T00:00:00Z"), updatedAt: new Date("2026-10-19T00:00:00Z") };
  const providerRows = new FakeRepository<VmProvider>({ ...stamp, lastTestedAt: null, lastErrorCode: null, reconcileLeaseUntil: null });
  const machineRows = new FakeRepository<HostVm>({
    ...stamp,
    spec: {},
    tags: [],
    observedState: "unknown",
    observedAt: null,
    operation: null,
    operationStep: null,
    operationTask: null,
    operationRequestedById: null,
    operationRequestedByName: null,
    operationStartedAt: null,
    operationUpdatedAt: null,
    errorCode: null,
    errorAt: null,
    idempotencyKey: null,
    version: 1,
  });
  const providers = new VmProvidersService(providerRows.asRepository(), machineRows.asRepository(), (_kind: VmProviderKind, _config, secret) => {
    factorySecrets.push(secret);
    return driver;
  });
  const published: HostEvent[] = [];
  const events = { publish: (event: HostEvent) => published.push(event) } as unknown as HostEvents;
  const machines = new HostVmsService(machineRows.asRepository(), providers, hosts, events);
  machines.connect();
  const clock = { now: Date.parse("2026-10-19T09:00:00Z"), paused: false };
  const audits: AuditEntry[] = [];
  const operations = new VmOperationsService(machineRows.asRepository(), providers, events, {
    now: () => clock.now,
    sleep: async (ms) => {
      if (clock.paused) await Bun.sleep(1);
      else clock.now += ms;
    },
    audit: async (entry) => {
      audits.push(entry);
    },
  });
  const enrollment = new FakeEnrollment(clock);
  const lifecycle = new VmLifecycleService(machineRows.asRepository(), providers, machines, operations, hosts, events, enrollment, () => SERVER_URL);
  lifecycle.connect();
  return { driver, hosts, hostRows, providerRows, machineRows, providers, machines, published, factorySecrets, operations, audits, clock, enrollment, lifecycle };
}

export async function addHost(harness: VmHarness, label: string, organizationId = ORG): Promise<Host> {
  return harness.hostRows.save(harness.hostRows.create({ organizationId, label } as Partial<Host>) as Host);
}

/** A provider plus one host linked to machine 500 in `state`. */
export async function linkedMachine(
  harness: VmHarness,
  state: "running" | "hibernated" | "stopped",
  overrides: Partial<VmProviderInput> = {},
  tags: string[] = [],
): Promise<{ hostId: string; providerId: string }> {
  const provider = await harness.providers.create(ORG, providerInput(overrides));
  const host = await addHost(harness, "box");
  harness.driver.add(500, state, { tags });
  await harness.machines.link(ORG, host.id, { providerId: provider.id, node: "n1", vmid: 500 });
  harness.published.length = 0;
  harness.driver.calls.length = 0;
  return { hostId: host.id, providerId: provider.id };
}
