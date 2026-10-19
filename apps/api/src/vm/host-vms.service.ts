import type { Repository } from "typeorm";
import { In } from "typeorm";
import { AppException } from "../common/app-exception";
import type { HostView } from "../hosts/host-view";
import type { HostsService } from "../hosts/hosts.service";
import type { HostEvents } from "../pdmux/host-events";
import { HostVm, type HostVmOperation, type HostVmOrigin } from "./host-vm.entity";
import type { VmAction, VmProviderConfig, VmProviderKind, VmState } from "./vm-provider";
import type { VmProvider } from "./vm-provider.entity";
import type { VmProvidersService } from "./vm-providers.service";

/** The machine behind a host, as every screen shows it. */
export interface HostVmView {
  provider: { id: string; kind: VmProviderKind; name: string };
  origin: HostVmOrigin;
  name: string;
  location: string;
  externalId: string;
  state: VmState;
  observedAt: string | null;
  /** The one change in flight, and who asked for it — so every pane can say so. */
  operation: {
    action: HostVmOperation;
    step: string | null;
    startedAt: string;
    requestedBy: { id: string | null; name: string | null };
  } | null;
  error: { code: string; at: string } | null;
  /** What the machine's state allows now. Who may do it is the screen's business (`/fleet/scope`). */
  available: VmAvailability;
}

/** A power change, deleting a machine pdmux created, or handing a created machine a new enrollment code. */
export type VmAvailability = Record<VmAction | "delete" | "enroll", boolean>;

/** The errors after which a created machine may be given a fresh enrollment code and restarted. */
export const ENROLL_RETRY_ERRORS: ReadonlySet<string> = new Set(["VM_ENROLL_TIMEOUT", "VM_ENROLL_FAILED"]);

const NOTHING: VmAvailability = {
  start: false,
  hibernate: false,
  shutdown: false,
  stop: false,
  reboot: false,
  reset: false,
  delete: false,
  enroll: false,
};

/**
 * Which changes a machine's state allows.
 *
 * ⚠ HIBERNATE MAY BE FENCED BY A TAG. A hibernated machine makes a scheduled backup of it fail
 * (Proxmox: `VM is locked (suspended)`), so an operator can restrict hibernation to machines
 * they took out of the backup schedule and marked — `sleepRequiresTag`. Without the tag the
 * machine can still be shut down.
 */
export function availableActions(
  vm: Pick<HostVm, "observedState" | "operation" | "origin" | "tags" | "errorCode">,
  config: Pick<VmProviderConfig, "sleepRequiresTag">,
): VmAvailability {
  if (vm.operation) return NOTHING;
  const sleepAllowed = config.sleepRequiresTag === null || vm.tags.includes(config.sleepRequiresTag);
  const created = vm.origin === "created";
  // A hibernated machine resumes its old firmware, so a new code needs it running or off.
  const enroll = created && vm.errorCode !== null && ENROLL_RETRY_ERRORS.has(vm.errorCode);
  switch (vm.observedState) {
    case "running":
      return { ...NOTHING, hibernate: sleepAllowed, shutdown: true, reboot: true, stop: true, reset: true, delete: created, enroll };
    case "hibernated":
      return { ...NOTHING, start: true, delete: created };
    case "stopped":
      return { ...NOTHING, start: true, delete: created, enroll };
    case "paused":
      return { ...NOTHING, stop: true, reset: true, delete: created };
    case "missing":
      return { ...NOTHING, delete: created };
    default:
      return NOTHING;
  }
}

export function hostVmView(vm: HostVm, provider: Pick<VmProvider, "id" | "kind" | "name" | "config">): HostVmView {
  return {
    provider: { id: provider.id, kind: provider.kind, name: provider.name },
    origin: vm.origin,
    name: vm.name,
    location: vm.location,
    externalId: vm.externalId,
    state: vm.observedState,
    observedAt: vm.observedAt ? vm.observedAt.toISOString() : null,
    operation: vm.operation
      ? {
          action: vm.operation,
          step: vm.operationStep,
          startedAt: (vm.operationStartedAt ?? vm.updatedAt).toISOString(),
          requestedBy: { id: vm.operationRequestedById, name: vm.operationRequestedByName },
        }
      : null,
    error: vm.errorCode ? { code: vm.errorCode, at: (vm.errorAt ?? vm.updatedAt).toISOString() } : null,
    available: availableActions(vm, provider.config),
  };
}

export interface LinkInput {
  providerId: string;
  node: string;
  vmid: number;
}

/**
 * The link between a host and its machine, and the guards that keep the two from drifting.
 *
 * A host whose machine pdmux created cannot be deleted on its own — that would leave a running
 * machine nobody can see — so it is removed with the machine. Any host with a machine stays in
 * its scope: the provider credentials belong to the scope.
 */
export class HostVmsService {
  /** Hosts whose machine is being deleted right now; their host row may go. */
  private readonly releasing = new Set<string>();

  constructor(
    private readonly machines: Repository<HostVm>,
    private readonly providers: VmProvidersService,
    private readonly hosts: HostsService,
    private readonly events: HostEvents,
  ) {}

  connect(): void {
    this.hosts.addRemovingGuard((hostId, organizationId) => this.guardRemoval(organizationId, hostId));
    this.hosts.addMovingGuard((hostId, organizationId) => this.guardMove(organizationId, hostId));
    this.hosts.setViewExtension((organizationId, views) => this.decorate(organizationId, views));
  }

  async link(organizationId: string, hostId: string, input: LinkInput): Promise<HostVmView> {
    const host = await this.hosts.get(organizationId, hostId);
    const provider = await this.providers.row(organizationId, input.providerId);
    if (await this.machines.findOne({ where: { hostId: host.id } })) {
      throw new AppException("VM_ALREADY_LINKED", "This host already has a machine", 409);
    }
    const externalId = String(input.vmid);
    if (await this.machines.findOne({ where: { providerId: provider.id, externalId } })) {
      throw new AppException("VM_LINKED_ELSEWHERE", "This machine is already linked to another host", 409);
    }
    const observed = await this.providers.driver(provider).status({ node: input.node, vmid: input.vmid });
    if (!observed) throw new AppException("VM_NOT_FOUND", "The provider has no such machine for these credentials", 404);
    if (observed.template) throw new AppException("VM_IS_TEMPLATE", "A template cannot be linked to a host", 400);
    const row = await this.machines.save(this.machines.create({
      organizationId,
      hostId: host.id,
      providerId: provider.id,
      location: observed.ref.node,
      externalId,
      name: observed.name || externalId,
      origin: "linked",
      spec: { cores: observed.cores ?? undefined, memoryMb: observed.memoryMb ?? undefined },
      tags: observed.tags,
      observedState: observed.state,
      observedAt: new Date(),
    }));
    this.events.publish({ type: "host.vm", hostId: host.id });
    return hostVmView(row, provider);
  }

  async unlink(organizationId: string, hostId: string): Promise<{ hostId: string; name: string }> {
    const row = await this.machine(organizationId, hostId);
    if (row.origin === "created") {
      throw new AppException("VM_CREATED_BY_PDMUX", "Delete a machine pdmux created instead of unlinking it", 409);
    }
    if (row.operation) throw new AppException("VM_OPERATION_IN_PROGRESS", "Wait for the machine's current change to finish", 409);
    await this.machines.delete({ id: row.id });
    this.events.publish({ type: "host.vm", hostId });
    return { hostId, name: row.name };
  }

  async machine(organizationId: string, hostId: string): Promise<HostVm> {
    const row = await this.machines.findOne({ where: { organizationId, hostId } });
    if (!row) throw new AppException("VM_NOT_LINKED", "This host has no machine", 404);
    return row;
  }

  /** Attach each host's machine to the views being returned. One query per list. */
  async decorate(organizationId: string, views: HostView[]): Promise<HostView[]> {
    if (views.length === 0) return views;
    const rows = await this.machines.find({ where: { organizationId, hostId: In(views.map((view) => view.id)) } });
    if (rows.length === 0) return views;
    const providerIds = [...new Set(rows.map((row) => row.providerId))];
    const providers = new Map<string, VmProvider>();
    for (const id of providerIds) providers.set(id, await this.providers.row(organizationId, id));
    const byHost = new Map(rows.map((row) => [row.hostId, row]));
    return views.map((view) => {
      const row = byHost.get(view.id);
      const provider = row ? providers.get(row.providerId) : undefined;
      return row && provider ? { ...view, vm: hostVmView(row, provider) } : view;
    });
  }

  /** Lets the deletion of a created machine remove its host row; see `releasing`. */
  async releaseHost<T>(hostId: string, remove: () => Promise<T>): Promise<T> {
    this.releasing.add(hostId);
    try {
      return await remove();
    } finally {
      this.releasing.delete(hostId);
    }
  }

  private async guardRemoval(organizationId: string, hostId: string): Promise<void> {
    if (this.releasing.has(hostId)) return;
    const row = await this.machines.findOne({ where: { organizationId, hostId } });
    if (row?.origin === "created") {
      throw new AppException("VM_DELETE_REQUIRED", "Delete this host's machine to remove the host", 409);
    }
    if (row?.operation) throw new AppException("VM_OPERATION_IN_PROGRESS", "Wait for the machine's current change to finish", 409);
  }

  private async guardMove(organizationId: string, hostId: string): Promise<void> {
    if (await this.machines.findOne({ where: { organizationId, hostId } })) {
      throw new AppException("VM_HOST_MOVE_BLOCKED", "A host with a machine stays with the provider's account", 409);
    }
  }
}
