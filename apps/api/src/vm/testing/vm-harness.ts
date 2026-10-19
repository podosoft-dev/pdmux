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
  return { driver, hosts, hostRows, providerRows, machineRows, providers, machines, published, factorySecrets };
}

export async function addHost(harness: VmHarness, label: string, organizationId = ORG): Promise<Host> {
  return harness.hostRows.save(harness.hostRows.create({ organizationId, label } as Partial<Host>) as Host);
}
