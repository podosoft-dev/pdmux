import { IsNull, type Repository } from "typeorm";
import { recordAudit, type AuditEntry } from "../audit/audit-events";
import { AppException } from "../common/app-exception";
import { ProductLogger } from "../logging/product-logger";
import type { HostEvents } from "../pdmux/host-events";
import type { HostVm } from "./host-vm.entity";
import { availableActions, hostVmView, type HostVmView } from "./host-vms.service";
import type { ObservedVm, ProviderTask, TaskResult, VmAction, VmProviderDriver, VmRef, VmState } from "./vm-provider";
import type { VmProvider } from "./vm-provider.entity";
import type { VmProvidersService } from "./vm-providers.service";

/** Who asked. Shown on every pane while the change runs, and written to the audit log. */
export interface VmActor {
  id: string;
  name: string;
}

/**
 * How long each step may take before it is called failed.
 *
 * A guest that ignores an ACPI power-off is the common slow case: measured on Proxmox 9.2,
 * a machine still booting after a reset let `shutdown` run its full 120-second timeout and
 * fail. The provider's own task timeout comes first; these are the backstop.
 */
const DEADLINE_MS: Record<VmAction | "backup", number> = {
  start: 5 * 60_000,
  hibernate: 15 * 60_000,
  shutdown: 6 * 60_000,
  stop: 2 * 60_000,
  reboot: 6 * 60_000,
  reset: 2 * 60_000,
  backup: 60 * 60_000,
};

/** An operation whose driver stopped touching it this long ago is resumed by the reconcile. */
const STALE_MS = 2 * 60_000;
/** A backup newer than this is recent enough to hibernate on. */
const BACKUP_FRESH_MS = 24 * 60 * 60_000;
/** How often the reconcile reads every provider. */
const RECONCILE_MS = 60_000;
/** One replica owns a provider's reconcile for this long. */
const LEASE_MS = 50_000;
/**
 * A reconcile pass that has not finished in this long is abandoned so the next one can run.
 *
 * ⚠ A DATABASE THAT GOES AWAY MID-QUERY CAN LEAVE THE QUERY UNSETTLED. Measured 2026-10-19: the
 * database container stopped under a running pass, the pass never resolved, and since a new pass
 * joins the running one, the loop stopped for good — a shutdown claimed just before was never
 * finished. A pass gets a deadline; past it, the next tick starts afresh.
 */
const PASS_DEADLINE_MS = 3 * 60_000;
/**
 * The state each change promises, and how long to wait for it after the provider's task ends.
 *
 * ⚠ A PROXMOX REBOOT TASK ENDS BEFORE THE MACHINE IS BACK. It shuts the guest down with a reboot
 * flag and its event daemon starts it again afterwards, so the task is "OK" while the machine is
 * still stopped (measured on 9.2.21: OK in 1.3 s, state `stopped`). Finishing there would paint
 * every pane "off" for the half minute until the next reconcile.
 */
const SETTLES_TO: Record<VmAction, VmState> = {
  start: "running",
  hibernate: "hibernated",
  shutdown: "stopped",
  stop: "stopped",
  reboot: "running",
  reset: "running",
};
const SETTLE_MS = 90_000;

/** A driver that has not touched its change for this long is presumed stuck and replaced. */
const HUNG_MS = 2 * STALE_MS;

export function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function refOf(row: Pick<HostVm, "location" | "externalId">): VmRef {
  return { node: row.location, vmid: Number(row.externalId) };
}

function observedPatch(observed: ObservedVm, now: Date): Partial<HostVm> {
  return {
    observedState: observed.state,
    observedAt: now,
    location: observed.ref.node,
    tags: observed.tags,
    ...(observed.name ? { name: observed.name } : {}),
  };
}

export interface VmOperationsOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  audit?: (entry: AuditEntry) => Promise<void>;
  /** Test seam for `PASS_DEADLINE_MS`. */
  passDeadlineMs?: number;
}

/**
 * Power changes, one per machine at a time, and the loop that keeps every machine's state true.
 *
 * ⚠ CLAIMING IS A CONDITIONAL WRITE, NOT A CHECK. Two panes — or two people — pressing a power
 * button on the same machine in the same second must start one task. Reading `operation` and
 * then writing it lets both through; the claim is an UPDATE that only matches while
 * `operation IS NULL` at the version just read, and the loser gets 409 with the winner's
 * action and name — which is also what every pane then shows.
 *
 * ⚠ THE PROVIDER IS OBSERVED, NOT TRUSTED TO STAY PUT. Someone may start a machine from the
 * provider's own console or a script. The reconcile reads every provider once a minute and
 * writes what it sees, so the screens catch up within a minute of a change pdmux did not make.
 */
export class VmOperationsService {
  private readonly logger = new ProductLogger(VmOperationsService.name);
  private readonly driving = new Map<string, Promise<void>>();
  /** The latest driver of each change. A replaced (stuck) driver checks this and stops writing. */
  private readonly generations = new Map<string, number>();
  private generation = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly audit: (entry: AuditEntry) => Promise<void>;
  private readonly passDeadlineMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconciling: Promise<void> | null = null;

  constructor(
    private readonly machines: Repository<HostVm>,
    private readonly providers: VmProvidersService,
    private readonly events: HostEvents,
    options: VmOperationsOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.audit = options.audit ?? recordAudit;
    this.passDeadlineMs = options.passDeadlineMs ?? PASS_DEADLINE_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.reconcileAll(), RECONCILE_MS);
    // Soon after startup too: an operation a previous process left behind should not wait a minute.
    setTimeout(() => void this.reconcileAll(), 5_000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.driving.values(), this.reconciling]);
  }

  /** Wait for every change this process is driving — for tests and for an orderly shutdown. */
  async settled(): Promise<void> {
    while (this.driving.size > 0) await Promise.allSettled([...this.driving.values()]);
  }

  async power(organizationId: string, hostId: string, action: VmAction, actor: VmActor): Promise<HostVmView> {
    const row = await this.machines.findOne({ where: { organizationId, hostId } });
    if (!row) throw new AppException("VM_NOT_LINKED", "This host has no machine", 404);
    if (row.operation) throw inProgress(row);
    // Read once: the claim below is conditional on THIS version, whatever happens meanwhile.
    const version = row.version;
    const provider = await this.providers.row(organizationId, row.providerId);
    const driver = this.providers.driver(provider);

    // The screen may be a minute behind; decide on what the provider says now.
    const observed = await driver.status(refOf(row));
    const now = new Date(this.now());
    if (!observed) {
      await this.machines.update({ id: row.id }, { observedState: "missing", observedAt: now });
      this.events.publish({ type: "host.vm", hostId });
      throw new AppException("VM_NOT_FOUND", "The provider has no such machine for these credentials", 404);
    }
    // Whether the STATE allows it. A concurrent claim is the conditional write's business, so the
    // operation is left out here — otherwise the loser of a race is told "not available".
    const candidate = { ...row, ...observedPatch(observed, now), operation: null };
    if (!availableActions(candidate, provider.config)[action]) {
      await this.machines.update({ id: row.id }, observedPatch(observed, now));
      this.events.publish({ type: "host.vm", hostId });
      throw new AppException("VM_ACTION_NOT_AVAILABLE", "The machine's state does not allow this now", 409, {
        action,
        state: observed.state,
      });
    }

    const claimed = await this.machines.update(
      { id: row.id, version, operation: IsNull() },
      {
        ...observedPatch(observed, now),
        operation: action,
        operationStep: action === "hibernate" && provider.config.backupBeforeSleep ? "backup" : "request",
        operationTask: null,
        operationRequestedById: actor.id,
        operationRequestedByName: actor.name,
        operationStartedAt: now,
        operationUpdatedAt: now,
        errorCode: null,
        errorAt: null,
        version: version + 1,
      },
    );
    if (claimed.affected === 0) {
      const current = await this.machines.findOne({ where: { id: row.id } });
      throw inProgress(current ?? row);
    }
    this.events.publish({ type: "host.vm", hostId });
    this.drive(row.id);
    const current = await this.machines.findOne({ where: { id: row.id } });
    return hostVmView(current ?? row, provider);
  }

  /** Read every provider and write what it sees; resume changes another process left behind. */
  async reconcileAll(): Promise<void> {
    if (this.reconciling) return this.reconciling;
    const pass = (async () => {
      for (const provider of await this.providers.allRows()) {
        try {
          if (await this.claimLease(provider)) await this.reconcileProvider(provider);
        } catch (error) {
          this.logger.warn(`Reconcile provider failed provider=${provider.id}: ${String(error)}`);
        }
      }
    })();
    this.reconciling = withDeadline(pass, this.passDeadlineMs, "VM reconcile")
      .catch((error: unknown) => this.logger.warn(`Reconcile machines failed: ${String(error)}`))
      .finally(() => {
        this.reconciling = null;
      });
    return this.reconciling;
  }

  async reconcileProvider(provider: VmProvider): Promise<void> {
    const rows = await this.machines.find({ where: { providerId: provider.id } });
    if (rows.length === 0) return;
    let observed: ObservedVm[];
    try {
      observed = await this.providers.driver(provider).list();
    } catch (error) {
      // An unreachable provider says nothing about its machines; leave their state as it was.
      this.logger.warn(`Read provider machines failed provider=${provider.id}: ${String(error)}`);
      return;
    }
    const byId = new Map(observed.map((vm) => [String(vm.ref.vmid), vm]));
    const now = new Date(this.now());
    for (const row of rows) {
      const seen = byId.get(row.externalId);
      const patch: Partial<HostVm> = seen ? observedPatch(seen, now) : { observedState: "missing", observedAt: now };
      const changed = patch.observedState !== row.observedState
        || (patch.location !== undefined && patch.location !== row.location)
        || (patch.tags !== undefined && patch.tags.join(",") !== row.tags.join(","));
      await this.machines.update({ id: row.id }, patch);
      if (changed) this.events.publish({ type: "host.vm", hostId: row.hostId });
      const idle = row.operation ? this.now() - (row.operationUpdatedAt?.getTime() ?? 0) : 0;
      // Nobody is driving it (another process died), or this process's driver stopped touching it.
      if (row.operation && idle > STALE_MS && (!this.driving.has(row.id) || idle > HUNG_MS)) this.drive(row.id, true);
    }
  }

  private claimLease(provider: VmProvider): Promise<boolean> {
    return this.providers.claimLease(provider.id, new Date(this.now()), new Date(this.now() + LEASE_MS));
  }

  private drive(id: string, replace = false): void {
    if (this.driving.has(id) && !replace) return;
    const generation = ++this.generation;
    this.generations.set(id, generation);
    const run = this.run(id, generation)
      .catch((error: unknown) => this.logger.warn(`Drive machine change failed machine=${id}: ${String(error)}`))
      .finally(() => {
        if (this.generations.get(id) !== generation) return;
        this.driving.delete(id);
        this.generations.delete(id);
      });
    this.driving.set(id, run);
  }

  private current(id: string, generation: number): boolean {
    return this.generations.get(id) === generation;
  }

  private async run(id: string, generation: number): Promise<void> {
    let row = await this.machines.findOne({ where: { id } });
    if (!row?.operation || !isPower(row.operation)) return;
    const action = row.operation;
    const provider = await this.providers.row(row.organizationId, row.providerId);
    const driver = this.providers.driver(provider);
    const ref = refOf(row);

    try {
      if (row.operationStep === "backup") {
        const storage = provider.config.backupBeforeSleep;
        if (storage) {
          const outcome = row.operationTask
            ? await this.wait(row, driver, taskFrom(row), DEADLINE_MS.backup, generation)
            : await this.backupIfStale(row, driver, ref, storage, generation);
          if (!outcome.ok) return this.finish(row, provider, driver, outcome.error, generation);
        }
        await this.step(row, "request", null);
      }
      row = (await this.machines.findOne({ where: { id } })) ?? row;
      let task = row.operationTask ? taskFrom(row) : null;
      if (row.operationStep === "request" || !task) {
        task = await driver.power(ref, action);
        await this.step(row, "wait", task);
      }
      const outcome = await this.wait(row, driver, task, DEADLINE_MS[action], generation);
      if (outcome.ok) await this.settle(row, driver, SETTLES_TO[action], generation);
      return this.finish(row, provider, driver, outcome.ok ? null : outcome.error, generation);
    } catch (error) {
      return this.finish(row, provider, driver, error instanceof AppException ? error.code : "VM_TASK_FAILED", generation);
    }
  }

  /** Back up first when the newest backup is older than a day — the hibernated machine will not be. */
  private async backupIfStale(row: HostVm, driver: VmProviderDriver, ref: VmRef, storage: string, generation: number): Promise<{ ok: true } | { ok: false; error: string }> {
    const last = await driver.lastBackupAt(ref.vmid, ref.node, storage);
    if (last !== null && this.now() - last < BACKUP_FRESH_MS) return { ok: true };
    const task = await driver.backup(ref, storage, "pdmux before sleep");
    await this.step(row, "backup", task);
    const outcome = await this.wait(row, driver, task, DEADLINE_MS.backup, generation);
    return outcome.ok ? { ok: true } : { ok: false, error: "VM_BACKUP_FAILED" };
  }

  private async step(row: HostVm, step: string, task: ProviderTask | null): Promise<void> {
    const patch: Partial<HostVm> = {
      operationStep: step,
      operationTask: task ? task.id : null,
      operationUpdatedAt: new Date(this.now()),
    };
    Object.assign(row, patch);
    await this.machines.update({ id: row.id }, patch);
    this.events.publish({ type: "host.vm", hostId: row.hostId });
  }

  private async wait(row: HostVm, driver: VmProviderDriver, task: ProviderTask, deadlineMs: number, generation: number): Promise<{ ok: true } | { ok: false; error: string }> {
    // From this step's start, not the operation's: a long backup must not use up the power-off's time.
    const started = this.now();
    for (let polls = 0; ; polls++) {
      if (!this.current(row.id, generation)) throw new SupersededError();
      const result: TaskResult = await driver.task(task);
      if (result.done) return result.ok ? { ok: true } : { ok: false, error: result.error };
      if (this.now() - started > deadlineMs) return { ok: false, error: "VM_TASK_TIMEOUT" };
      // A heartbeat for the reconcile: a change still being driven is not stale.
      await this.machines.update({ id: row.id }, { operationUpdatedAt: new Date(this.now()) });
      await this.sleep(polls < 10 ? 1_000 : 3_000);
    }
  }

  /** After a successful task, wait a while for the state the change promises. No error if it does not come. */
  private async settle(row: HostVm, driver: VmProviderDriver, target: VmState, generation: number): Promise<void> {
    const started = this.now();
    for (;;) {
      if (!this.current(row.id, generation)) throw new SupersededError();
      const observed = await driver.status(refOf(row)).catch(() => null);
      if (!observed || observed.state === target || this.now() - started > SETTLE_MS) return;
      await this.machines.update({ id: row.id }, { operationUpdatedAt: new Date(this.now()) });
      await this.sleep(2_000);
    }
  }

  private async finish(row: HostVm, provider: VmProvider, driver: VmProviderDriver, errorCode: string | null, generation: number): Promise<void> {
    // A replaced driver leaves the ending to its replacement.
    if (!this.current(row.id, generation)) return;
    const now = new Date(this.now());
    // Before the write that clears them.
    const { operation: action, operationRequestedById: actorId, operationRequestedByName: actorName } = row;
    const observed = await driver.status(refOf(row)).catch(() => null);
    await this.machines.update({ id: row.id }, {
      ...(observed ? observedPatch(observed, now) : {}),
      operation: null,
      operationStep: null,
      operationTask: null,
      operationRequestedById: null,
      operationRequestedByName: null,
      operationStartedAt: null,
      operationUpdatedAt: null,
      errorCode,
      errorAt: errorCode ? now : null,
    });
    this.events.publish({ type: "host.vm", hostId: row.hostId });
    await this.audit({
      action: errorCode ? "vm.power.failed" : "vm.power.completed",
      actorId,
      actorName,
      targetType: "host",
      targetId: row.hostId,
      targetLabel: row.name,
      metadata: { action, provider: provider.name, location: row.location, externalId: row.externalId, ...(errorCode ? { errorCode } : {}) },
    }).catch((error: unknown) => this.logger.warn(`Record machine change failed machine=${row.id}: ${String(error)}`));
  }
}

/** Thrown inside a driver that a newer one replaced; it ends that driver quietly. */
class SupersededError extends Error {
  constructor() {
    super("A newer driver took over this change");
  }
}

function isPower(operation: string): operation is VmAction {
  return ["start", "hibernate", "shutdown", "stop", "reboot", "reset"].includes(operation);
}

function taskFrom(row: HostVm): ProviderTask {
  const id = row.operationTask ?? "";
  return { id, node: id.split(":")[1] ?? row.location };
}

function inProgress(row: HostVm): AppException {
  return new AppException("VM_OPERATION_IN_PROGRESS", "Another change to this machine is running", 409, {
    action: row.operation,
    requestedBy: row.operationRequestedByName,
    startedAt: row.operationStartedAt ? row.operationStartedAt.toISOString() : null,
  });
}
