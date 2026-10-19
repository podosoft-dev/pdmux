import { AppException } from "../../common/app-exception";
import type {
  CloneSpec,
  ObservedVm,
  ProviderTask,
  TaskResult,
  VmAction,
  VmCatalog,
  VmProviderDriver,
  VmRef,
  VmSettings,
} from "../vm-provider";

/**
 * An in-memory provider for service specs: machines, tasks that finish when told, and a
 * record of every call. A test drives it the way a real platform behaves — tasks take time,
 * ids can be taken by machines the credentials cannot see, a guest can refuse to power off.
 */
export class FakeDriver implements VmProviderDriver {
  readonly kind = "proxmox" as const;
  readonly calls: string[] = [];
  readonly machines = new Map<number, ObservedVm>();
  /** Ids held by machines these credentials cannot see. */
  readonly hidden = new Set<number>();
  readonly backups = new Map<number, number>();
  readonly settings = new Map<number, VmSettings>();
  /** Tasks by id; `result` stays `undefined` while running. */
  readonly tasks = new Map<string, { result?: TaskResult; apply?: () => void }>();
  /** When set, `test()` throws this. */
  failTest: AppException | null = null;
  /** When set, the next task for this action ends with this error code. */
  failAction = new Map<string, string>();
  /** Tasks finish at once unless this is false. */
  autoFinish = true;
  /** Like Proxmox: a reboot's task ends with the machine stopped; it comes back after `rebootPolls` status reads. */
  rebootPolls = 0;
  private rebooting = new Map<number, number>();
  private sequence = 0;

  add(vmid: number, state: ObservedVm["state"], extra: Partial<ObservedVm> = {}): ObservedVm {
    const vm: ObservedVm = { ref: { node: "n1", vmid }, name: `vm-${vmid}`, state, tags: [], template: false, memoryMb: 2048, cores: 2, ...extra };
    this.machines.set(vmid, vm);
    return vm;
  }

  async test(): Promise<{ version: string }> {
    this.calls.push("test");
    if (this.failTest) throw this.failTest;
    return { version: "9.2.21" };
  }

  async discover(): Promise<VmCatalog> {
    this.calls.push("discover");
    return { nodes: [{ name: "n1", online: true }], templates: [], storages: [], bridges: [], pools: [] };
  }

  async list(): Promise<ObservedVm[]> {
    this.calls.push("list");
    return [...this.machines.values()].map((vm) => ({ ...vm, tags: [...vm.tags] }));
  }

  async status(ref: VmRef): Promise<ObservedVm | null> {
    this.calls.push(`status ${ref.vmid}`);
    const vm = this.machines.get(ref.vmid);
    const left = this.rebooting.get(ref.vmid);
    if (vm && left !== undefined) {
      if (left <= 0) {
        vm.state = "running";
        this.rebooting.delete(ref.vmid);
      } else this.rebooting.set(ref.vmid, left - 1);
    }
    return vm ? { ...vm, tags: [...vm.tags] } : null;
  }

  async power(ref: VmRef, action: VmAction): Promise<ProviderTask> {
    this.calls.push(`${action} ${ref.vmid}`);
    const vm = this.machines.get(ref.vmid);
    if (!vm) throw new AppException("VM_NOT_FOUND", "The provider has no such machine", 404);
    const next: Record<VmAction, ObservedVm["state"]> = {
      start: "running", hibernate: "hibernated", shutdown: "stopped", stop: "stopped", reboot: "running", reset: "running",
    };
    if (action === "reboot" && this.rebootPolls > 0) {
      return this.startTask(action, () => {
        vm.state = "stopped";
        this.rebooting.set(ref.vmid, this.rebootPolls);
      });
    }
    return this.startTask(action, () => (vm.state = next[action]));
  }

  async clone(spec: CloneSpec): Promise<ProviderTask> {
    this.calls.push(`clone ${spec.template.vmid}->${spec.vmid}`);
    return this.startTask("clone", () => this.add(spec.vmid, "stopped", { name: spec.name }));
  }

  async configure(ref: VmRef, settings: VmSettings): Promise<void> {
    this.calls.push(`configure ${ref.vmid}`);
    this.settings.set(ref.vmid, { ...(this.settings.get(ref.vmid) ?? {}), ...settings });
    const vm = this.machines.get(ref.vmid);
    if (vm && settings.tags) vm.tags = settings.tags;
  }

  async remove(ref: VmRef): Promise<ProviderTask | null> {
    this.calls.push(`remove ${ref.vmid}`);
    if (!this.machines.has(ref.vmid)) return null;
    return this.startTask("remove", () => this.machines.delete(ref.vmid));
  }

  async backup(ref: VmRef): Promise<ProviderTask> {
    this.calls.push(`backup ${ref.vmid}`);
    return this.startTask("backup", () => this.backups.set(ref.vmid, Date.now()));
  }

  async lastBackupAt(vmid: number): Promise<number | null> {
    this.calls.push(`lastBackup ${vmid}`);
    return this.backups.get(vmid) ?? null;
  }

  async vmidFree(vmid: number): Promise<boolean> {
    this.calls.push(`free ${vmid}`);
    return !this.machines.has(vmid) && !this.hidden.has(vmid);
  }

  async task(task: ProviderTask): Promise<TaskResult> {
    this.calls.push(`poll ${task.id}`);
    return this.tasks.get(task.id)?.result ?? { done: false };
  }

  /** A provider task for `kind`; it finishes at once unless `autoFinish` is off or a failure is queued. */
  startTask(kind: string, apply: () => void): ProviderTask {
    const id = `UPID:n1:${(++this.sequence).toString(16).padStart(8, "0")}:${kind}:`;
    const failure = this.failAction.get(kind);
    const entry: { result?: TaskResult; apply?: () => void } = { apply };
    this.tasks.set(id, entry);
    if (failure) {
      this.failAction.delete(kind);
      entry.result = { done: true, ok: false, error: failure };
    } else if (this.autoFinish) {
      apply();
      entry.result = { done: true, ok: true };
    }
    return { id, node: "n1" };
  }

  /** Finish every running task successfully. */
  finishAll(): void {
    for (const entry of this.tasks.values()) {
      if (entry.result) continue;
      entry.apply?.();
      entry.result = { done: true, ok: true };
    }
  }
}
