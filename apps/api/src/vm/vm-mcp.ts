import type { DestroyItem, DestroyPlan, VmCreateRequest, VmPowerAction } from "@pdmux/mcp";
import { AppException } from "../common/app-exception";
import type { HostsService } from "../hosts/hosts.service";
import type { FleetVmTools, VmToolActor } from "../mcp/fleet-gateway";
import type { CreatedVm } from "./vm-lifecycle.service";
import type { HostVmView } from "./host-vms.service";
import type { VmServices } from "./vm.module-key";

/** Changes that cut power without asking the guest. */
const FORCED: ReadonlySet<VmPowerAction> = new Set(["stop", "reset"]);

/**
 * The VM provider, as the MCP fleet tools reach it — scoped, like every fleet tool, by
 * resolving the host in the caller's scope before anything else.
 *
 * ⚠ A MODEL DOES NOT SEE WHO IS WORKING ON A MACHINE. A person pressing "restart" sees the
 * panes they are about to close; a coding agent calling `vm_power` does not. So a change that
 * would end other people's sessions or cut their terminals is described first and needs
 * `confirm`, the same as a destructive tool — and a change that cuts nobody off runs at once.
 */
export class VmFleetTools implements FleetVmTools {
  constructor(
    private readonly vm: VmServices,
    private readonly hosts: HostsService,
  ) {}

  async status(scope: string, hostId: string | null): Promise<unknown> {
    if (!hostId) {
      const providers = await this.vm.providers.list(scope);
      return {
        providers: providers.map((provider) => ({
          id: provider.id,
          name: provider.name,
          kind: provider.kind,
          defaultTemplate: provider.defaults.template,
          machineCount: provider.machineCount,
          lastErrorCode: provider.lastErrorCode,
        })),
      };
    }
    const host = await this.hosts.getView(scope, hostId);
    return { hostId: host.id, label: host.label, online: host.online, vm: host.vm ?? null };
  }

  async powerPlan(scope: string, hostId: string, action: VmPowerAction): Promise<DestroyPlan | null> {
    const host = await this.hosts.getView(scope, hostId);
    if (!host.vm) throw new AppException("VM_NOT_LINKED", "This host has no machine", 404);
    if (action === "start") return null;
    const attached = host.sessions.reduce((total, session) => total + Math.max(0, session.attached), 0);
    const items: DestroyItem[] = [];
    if (FORCED.has(action)) {
      items.push({ type: "guest-state", note: "power is cut without asking the guest — unsaved work on the machine is lost" });
    }
    // Hibernating keeps every process; the others end them.
    if (action !== "hibernate" && host.sessions.length > 0) {
      items.push({ type: "terminal-session", count: host.sessions.length, note: "ends with the machine's processes, and whatever runs in it" });
    }
    if (attached > 0) {
      items.push({
        type: "terminal-connection",
        count: attached,
        note: action === "hibernate" ? "cut until the machine is woken; the sessions resume where they were" : "cut — someone may be working in it",
      });
    }
    if (items.length === 0) return null;
    return { willDestroy: items, reversible: action === "hibernate", retryWith: { hostId, action, confirm: true } };
  }

  power(scope: string, hostId: string, action: VmPowerAction, actor: VmToolActor): Promise<HostVmView> {
    return this.vm.operations.power(scope, hostId, action, actor);
  }

  async create(scope: string, input: VmCreateRequest & { idempotencyKey: string }, actor: VmToolActor): Promise<CreatedVm> {
    let providerId = input.providerId;
    if (!providerId) {
      const providers = await this.vm.providers.list(scope);
      if (providers.length === 0) throw new AppException("VM_PROVIDERS_NONE", "This fleet has no VM provider", 400);
      if (providers.length > 1) {
        throw new AppException("VM_PROVIDER_REQUIRED", `Name a provider: ${providers.map((provider) => `${provider.name} (${provider.id})`).join(", ")}`, 400);
      }
      providerId = providers[0]?.id ?? "";
    }
    const template = input.templateNode && input.templateVmid ? { node: input.templateNode, vmid: input.templateVmid } : null;
    return this.vm.lifecycle.create(scope, {
      providerId,
      label: input.label,
      template,
      cores: input.cores ?? null,
      memoryMb: input.memoryMb ?? null,
      idempotencyKey: input.idempotencyKey,
    }, actor);
  }

  async deletePlan(scope: string, hostId: string): Promise<DestroyPlan> {
    const host = await this.hosts.getView(scope, hostId);
    const machine = await this.vm.machines.machine(scope, hostId);
    if (machine.origin !== "created") {
      throw new AppException("VM_NOT_CREATED_BY_PDMUX", "Only a machine pdmux created can be deleted; unlink this one instead", 409);
    }
    const provider = await this.vm.providers.get(scope, machine.providerId);
    return {
      willDestroy: [
        { type: "vm", id: machine.externalId, label: machine.name, note: `deleted at ${provider.name} with its disks — backups there are kept` },
        { type: "host", id: host.id, label: host.label },
        { type: "agent-token", note: "cascade — the machine's agent credentials" },
        { type: "metric-history", note: "every sample recorded for this host" },
        ...(host.sessions.length > 0 ? [{ type: "terminal-session", count: host.sessions.length, note: "ends with the machine" }] : []),
      ],
      reversible: false,
      // The name travels in the plan, so confirming echoes it and the server compares it — the
      // tool's equivalent of typing the name on the screen.
      retryWith: { hostId, confirmName: machine.name, confirm: true },
    };
  }

  remove(scope: string, hostId: string, confirmName: string, actor: VmToolActor): Promise<HostVmView> {
    return this.vm.lifecycle.remove(scope, hostId, confirmName, actor);
  }
}
