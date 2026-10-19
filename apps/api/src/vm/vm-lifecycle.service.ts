import type { Repository } from "typeorm";
import { AppException } from "../common/app-exception";
import type { HostsService } from "../hosts/hosts.service";
import { ProductLogger } from "../logging/product-logger";
import type { HostEvents } from "../pdmux/host-events";
import type { HostVm } from "./host-vm.entity";
import { availableActions, hostVmView, type HostVmView, type HostVmsService } from "./host-vms.service";
import {
  inProgress,
  refOf,
  SupersededError,
  taskFrom,
  type StepOutcome,
  type VmActor,
  type VmLifecycleRunner,
  type VmOperationsService,
  type VmStepKit,
} from "./vm-operations.service";
import type { VmProviderDriver, VmRef } from "./vm-provider";
import type { VmProvider } from "./vm-provider.entity";
import type { VmProvidersService } from "./vm-providers.service";

/** How a new machine gets its enrollment code, and how pdmux learns that it used it. */
export interface VmEnrollment {
  /** A fresh code for the host, retiring any earlier one. The code is handed to the provider and nowhere else. */
  mint(organizationId: string, hostId: string, actorId: string | null): Promise<{ code: string }>;
  /** `enrolled` once the code was redeemed, `expired` once it ran out unused, `waiting` before either. */
  state(organizationId: string, hostId: string): Promise<"enrolled" | "waiting" | "expired">;
}

export interface CreateVmInput {
  providerId: string;
  /** The host's label; the machine's name is derived from it. */
  label: string;
  template: VmRef | null;
  cores: number | null;
  memoryMb: number | null;
  idempotencyKey: string;
}

export interface CreatedVm {
  hostId: string;
  label: string;
  vm: HostVmView;
}

/** A full copy of a large disk is the slow case. */
const CLONE_MS = 30 * 60_000;
const START_MS = 5 * 60_000;
const REMOVE_MS = 10 * 60_000;
const ENROLL_POLL_MS = 3_000;

/** Every machine pdmux creates carries this tag, so the provider's own screens show who made it. */
export const CREATED_TAG = "pdmux";

/** A Proxmox VM name is a DNS label: lower-case letters, digits and hyphens. */
export function machineName(label: string, vmid: number): string {
  const name = label
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return name || `pdmux-${vmid}`;
}

function codeOf(error: unknown): string {
  return error instanceof AppException ? error.code : "VM_TASK_FAILED";
}

/** Postgres unique violation, and which index raised it. */
function uniqueViolation(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const direct = error as { code?: string; constraint?: string; driverError?: { code?: string; constraint?: string } };
  const code = direct.code ?? direct.driverError?.code;
  if (code !== "23505") return null;
  return direct.constraint ?? direct.driverError?.constraint ?? "";
}

function templateOf(row: HostVm): VmRef {
  const [node = row.location, vmid = "0"] = (row.spec.template ?? "").split("/");
  return { node, vmid: Number(vmid) };
}

/**
 * Creating a machine from a template, deleting one pdmux created, and handing a created machine
 * a new enrollment code.
 *
 * These are changes like a power change: one at a time per machine, every step on the row so
 * every screen sees it, resumed by the reconcile if the process driving it dies. They differ in
 * having steps a power change does not — and in that a failed create may leave nothing behind
 * (no machine → no host), while a failed delete leaves everything (the host stays so it can be
 * tried again).
 *
 * ⚠ THE SERVER NEVER REACHES INTO THE MACHINE. A new machine learns its enrollment code and the
 * pdmux address from its firmware (SMBIOS serial and SKU, readable by root only), and a unit in
 * the template enrolls with them on first boot. The code lives 15 minutes and is used once; it is
 * cleared from the firmware as soon as the machine enrolled.
 */
export class VmLifecycleService implements VmLifecycleRunner {
  private readonly logger = new ProductLogger(VmLifecycleService.name);
  /** Requests with the same key in flight in this process share one create. */
  private readonly creating = new Map<string, Promise<CreatedVm>>();

  constructor(
    private readonly rows: Repository<HostVm>,
    private readonly providers: VmProvidersService,
    private readonly machines: HostVmsService,
    private readonly operations: VmOperationsService,
    private readonly hosts: HostsService,
    private readonly events: HostEvents,
    private readonly enrollment: VmEnrollment,
    /** The server's own public address, for a provider that names none. */
    private readonly serverUrl: () => string,
  ) {}

  connect(): void {
    this.operations.setLifecycle(this);
  }

  /**
   * Create a machine and the host it becomes, and start driving it. Answers at once: the host
   * is on every screen as "creating" from here on.
   *
   * ⚠ AN ID IS ONLY REUSED WHEN NOTHING REMEMBERS IT. Proxmox backup groups are keyed by the VM
   * id alone, so a new machine on an old id would have its backup pruning delete the old
   * machine's backups. An id is taken only when no machine anywhere holds it (including ones
   * these credentials cannot see) and no backup storage on the node has a backup of it.
   */
  async create(organizationId: string, input: CreateVmInput, actor: VmActor): Promise<CreatedVm> {
    const key = `${organizationId}:${input.idempotencyKey}`;
    const pending = this.creating.get(key);
    if (pending) return pending;
    const work = this.createOnce(organizationId, input, actor).finally(() => this.creating.delete(key));
    this.creating.set(key, work);
    return work;
  }

  /** Delete a machine pdmux created, then its host. The name must be typed again. */
  async remove(organizationId: string, hostId: string, confirmName: string, actor: VmActor): Promise<HostVmView> {
    const row = await this.machines.machine(organizationId, hostId);
    if (row.origin !== "created") {
      throw new AppException("VM_NOT_CREATED_BY_PDMUX", "Only a machine pdmux created can be deleted; unlink this one instead", 409);
    }
    // Checked before the provider is asked anything: a mistyped name changes nothing.
    if (confirmName.trim() !== row.name) {
      throw new AppException("VM_DELETE_NAME_MISMATCH", "The name typed does not match the machine's", 400);
    }
    const provider = await this.providers.row(organizationId, row.providerId);
    return this.start(row, provider, "delete", "stop", actor, "delete");
  }

  /** A created machine that never enrolled: a new code in its firmware, and a restart to read it. */
  async reenroll(organizationId: string, hostId: string, actor: VmActor): Promise<HostVmView> {
    const row = await this.machines.machine(organizationId, hostId);
    const provider = await this.providers.row(organizationId, row.providerId);
    return this.start(row, provider, "enroll", "firmware", actor, "enroll");
  }

  async run(row: HostVm, generation: number, kit: VmStepKit): Promise<void> {
    const provider = await this.providers.row(row.organizationId, row.providerId);
    const driver = this.providers.driver(provider);
    try {
      if (row.operation === "create") return await this.runCreate(row, provider, driver, generation, kit);
      if (row.operation === "enroll") return await this.runEnroll(row, provider, driver, generation, kit);
      if (row.operation === "delete") return await this.runDelete(row, provider, driver, generation, kit);
    } catch (error) {
      if (error instanceof SupersededError) return;
      return kit.finish(row, provider, driver, codeOf(error), generation);
    }
  }

  private async createOnce(organizationId: string, input: CreateVmInput, actor: VmActor): Promise<CreatedVm> {
    const earlier = await this.rows.findOne({ where: { organizationId, idempotencyKey: input.idempotencyKey } });
    if (earlier) return this.answer(organizationId, earlier);

    const provider = await this.providers.row(organizationId, input.providerId);
    const { defaults } = provider.config;
    const template = input.template ?? defaults.template;
    if (!template) throw new AppException("VM_TEMPLATE_REQUIRED", "Choose a template, or set a default one on the provider", 400);
    const driver = this.providers.driver(provider);
    const backupStores = (await driver.discover()).storages
      .filter((store) => store.node === template.node && store.content.includes("backup"))
      .map((store) => store.id);
    const ours = new Set((await this.rows.find({ where: { providerId: provider.id } })).map((row) => row.externalId));

    let vmid = await this.nextFree(driver, defaults.vmidMin, defaults.vmidMax, template.node, backupStores, ours);
    const host = await this.hosts.create(organizationId, { label: input.label });
    const now = new Date();
    for (;;) {
      try {
        const row = await this.rows.save(this.rows.create({
          organizationId,
          hostId: host.id,
          providerId: provider.id,
          location: template.node,
          externalId: String(vmid),
          name: machineName(input.label, vmid),
          origin: "created",
          spec: { cores: input.cores ?? defaults.cores, memoryMb: input.memoryMb ?? defaults.memoryMb, template: `${template.node}/${template.vmid}` },
          tags: [],
          observedState: "unknown",
          observedAt: null,
          operation: "create",
          operationStep: "clone",
          operationTask: null,
          operationRequestedById: actor.id,
          operationRequestedByName: actor.name,
          operationStartedAt: now,
          operationUpdatedAt: now,
          errorCode: null,
          errorAt: null,
          idempotencyKey: input.idempotencyKey,
        }));
        this.events.publish({ type: "host.vm", hostId: host.id });
        this.operations.kick(row.id);
        return this.answer(organizationId, row);
      } catch (error) {
        const index = uniqueViolation(error);
        if (index === null) {
          await this.dropHost(organizationId, host.id);
          throw error;
        }
        if (index.includes("idempotency")) {
          // Another replica created it with this key a moment ago: that one is the answer.
          await this.dropHost(organizationId, host.id);
          const other = await this.rows.findOne({ where: { organizationId, idempotencyKey: input.idempotencyKey } });
          if (other) return this.answer(organizationId, other);
          throw error;
        }
        // Someone took this id between the check and the insert: the next free one.
        ours.add(String(vmid));
        try {
          vmid = await this.nextFree(driver, vmid + 1, defaults.vmidMax, template.node, backupStores, ours);
        } catch (full) {
          await this.dropHost(organizationId, host.id);
          throw full;
        }
      }
    }
  }

  private async nextFree(driver: VmProviderDriver, from: number, to: number, node: string, backupStores: string[], ours: Set<string>): Promise<number> {
    for (let vmid = from; vmid <= to; vmid++) {
      if (ours.has(String(vmid))) continue;
      if (!(await driver.vmidFree(vmid))) continue;
      let backedUp = false;
      for (const store of backupStores) {
        if ((await driver.lastBackupAt(vmid, node, store)) !== null) {
          backedUp = true;
          break;
        }
      }
      if (!backedUp) return vmid;
    }
    throw new AppException("VM_ID_RANGE_FULL", "No id in the provider's range is free of machines and backups", 409, { from, to });
  }

  private async answer(organizationId: string, row: HostVm): Promise<CreatedVm> {
    const provider = await this.providers.row(organizationId, row.providerId);
    const host = await this.hosts.get(organizationId, row.hostId);
    return { hostId: row.hostId, label: host.label, vm: hostVmView(row, provider) };
  }

  /** A host made for a create that did not happen. Its row has no machine yet, so nothing guards it. */
  private async dropHost(organizationId: string, hostId: string): Promise<void> {
    await this.hosts.remove(organizationId, hostId).catch((error: unknown) => {
      this.logger.warn(`Remove the host of an abandoned create failed host=${hostId}: ${String(error)}`);
    });
  }

  private async start(row: HostVm, provider: VmProvider, operation: "delete" | "enroll", step: string, actor: VmActor, allow: "delete" | "enroll"): Promise<HostVmView> {
    // Who holds it, without asking the provider first; the claim below refuses a race the same way.
    if (row.operation) throw inProgress(row);
    const version = row.version;
    const observed = await this.providers.driver(provider).status(refOf(row));
    const state = observed ? observed.state : "missing";
    if (!availableActions({ ...row, observedState: state, operation: null }, provider.config)[allow]) {
      throw new AppException("VM_ACTION_NOT_AVAILABLE", "The machine's state does not allow this now", 409, { action: operation, state });
    }
    await this.operations.claim(row, version, operation, step, actor, { observedState: state, observedAt: new Date() });
    this.operations.kick(row.id);
    const current = await this.rows.findOne({ where: { id: row.id } });
    return hostVmView(current ?? row, provider);
  }

  private async runCreate(row: HostVm, provider: VmProvider, driver: VmProviderDriver, generation: number, kit: VmStepKit): Promise<void> {
    const ref = refOf(row);
    if (row.operationStep === "clone") {
      const outcome = await this.clone(row, provider, driver, ref, generation, kit);
      if (outcome === "abandoned") return;
      if (outcome !== "ok") return kit.finish(row, provider, driver, outcome, generation);
      await kit.step(row, "configure", null);
    }
    if (row.operationStep === "configure") {
      const sleepTag = provider.config.sleepRequiresTag;
      await driver.configure(ref, {
        cores: row.spec.cores,
        memoryMb: row.spec.memoryMb,
        // A balloon device at the full size: the guest can hand memory back, the host never takes it.
        balloonMb: row.spec.memoryMb,
        tags: [CREATED_TAG, ...(sleepTag && sleepTag !== CREATED_TAG ? [sleepTag] : [])],
        description: `pdmux host ${row.hostId}`,
      });
      await kit.step(row, "firmware", null);
    }
    return this.enrollFrom(row, provider, driver, ref, "start", generation, kit);
  }

  private async runEnroll(row: HostVm, provider: VmProvider, driver: VmProviderDriver, generation: number, kit: VmStepKit): Promise<void> {
    return this.enrollFrom(row, provider, driver, refOf(row), "restart", generation, kit);
  }

  /** firmware → start (or restart) → wait for the agent → clear the firmware. Shared by create and re-enroll. */
  private async enrollFrom(row: HostVm, provider: VmProvider, driver: VmProviderDriver, ref: VmRef, boot: "start" | "restart", generation: number, kit: VmStepKit): Promise<void> {
    if (row.operationStep === "firmware") {
      const enrollUrl = provider.config.enrollUrl ?? this.serverUrl();
      const { code } = await this.enrollment.mint(row.organizationId, row.hostId, row.operationRequestedById);
      await driver.configure(ref, { firmware: { serial: code, sku: enrollUrl } });
      await kit.step(row, boot, null);
    }
    if (row.operationStep === "start" || row.operationStep === "restart") {
      const outcome = await this.boot(row, driver, ref, row.operationStep, generation, kit);
      if (!outcome.ok) return kit.finish(row, provider, driver, outcome.error, generation);
      await kit.step(row, "enroll", null);
    }
    if (row.operationStep === "enroll") {
      const outcome = await this.awaitEnrollment(row, generation, kit);
      if (!outcome.ok) return kit.finish(row, provider, driver, outcome.error, generation);
      await kit.step(row, "clear", null);
    }
    if (row.operationStep === "clear") {
      // The code is spent once redeemed, so a failure here leaves nothing usable behind.
      await driver.configure(ref, { firmware: null }).catch((error: unknown) => {
        this.logger.warn(`Clear a machine's enrollment firmware failed machine=${row.id}: ${String(error)}`);
      });
    }
    return kit.finish(row, provider, driver, null, generation);
  }

  /** "ok", "abandoned" (nothing was made; the host is gone), or the error to end on with the machine kept. */
  private async clone(row: HostVm, provider: VmProvider, driver: VmProviderDriver, ref: VmRef, generation: number, kit: VmStepKit): Promise<string> {
    let task = row.operationTask ? taskFrom(row) : null;
    if (!task) {
      const existing = await driver.status(ref);
      if (existing) {
        // A process that died after asking for the clone, before recording it, left ours here.
        // Anything else at this id is someone else's, made since it was checked: never adopted.
        if (existing.name === row.name) return "ok";
        await this.abandon(row, provider, "VM_ID_TAKEN", generation, kit);
        return "abandoned";
      }
      try {
        task = await driver.clone({
          template: templateOf(row),
          vmid: ref.vmid,
          name: row.name,
          pool: provider.config.defaults.pool,
          full: provider.config.defaults.fullClone,
          storage: provider.config.defaults.storage,
        });
      } catch (error) {
        await this.abandon(row, provider, codeOf(error), generation, kit);
        return "abandoned";
      }
      await kit.step(row, "clone", task);
    }
    const outcome = await kit.wait(row, driver, task, CLONE_MS, generation);
    if (outcome.ok) return "ok";
    // A clone that failed late or timed out may have left ours (still copying, or half made): it is
    // kept for a delete. Only when nothing of ours is there is the create abandoned.
    const after = await driver.status(ref).catch(() => null);
    if (after?.name === row.name) return outcome.error;
    await this.abandon(row, provider, outcome.error, generation, kit);
    return "abandoned";
  }

  private async abandon(row: HostVm, provider: VmProvider, errorCode: string, generation: number, kit: VmStepKit): Promise<void> {
    if (!kit.current(row, generation)) return;
    await this.release(row);
    await kit.record(row, provider, errorCode);
  }

  /** Remove the host of a machine that is gone (or never was), through the host's own removal path. */
  private async release(row: HostVm): Promise<void> {
    await this.machines.releaseHost(row.hostId, () => this.hosts.remove(row.organizationId, row.hostId));
    // The database cascades this; said here too so no store that does not cascade keeps an orphan.
    await this.rows.delete({ id: row.id });
    this.events.publish({ type: "host.removed", hostId: row.hostId });
  }

  private async boot(row: HostVm, driver: VmProviderDriver, ref: VmRef, step: "start" | "restart", generation: number, kit: VmStepKit): Promise<StepOutcome> {
    let task = row.operationTask ? taskFrom(row) : null;
    if (!task) {
      const observed = await driver.status(ref);
      if (step === "start" && observed?.state === "running") return { ok: true };
      // A running machine reads new firmware only on a fresh boot; Proxmox's reboot is one.
      task = await driver.power(ref, observed?.state === "running" ? "reboot" : "start");
      await kit.step(row, step, task);
    }
    return kit.wait(row, driver, task, START_MS, generation);
  }

  private async awaitEnrollment(row: HostVm, generation: number, kit: VmStepKit): Promise<StepOutcome> {
    for (;;) {
      await kit.heartbeat(row, generation);
      const state = await this.enrollment.state(row.organizationId, row.hostId);
      if (state === "enrolled") return { ok: true };
      // The code is the deadline: once it expired unused, waiting longer cannot help.
      if (state === "expired") return { ok: false, error: "VM_ENROLL_TIMEOUT" };
      await kit.sleep(ENROLL_POLL_MS);
    }
  }

  private async runDelete(row: HostVm, provider: VmProvider, driver: VmProviderDriver, generation: number, kit: VmStepKit): Promise<void> {
    const ref = refOf(row);
    if (row.operationStep === "stop") {
      const outcome = await this.powerOff(row, driver, ref, generation, kit);
      if (!outcome.ok) return kit.finish(row, provider, driver, outcome.error, generation);
      await kit.step(row, "remove", null);
    }
    if (row.operationStep === "remove") {
      let task = row.operationTask ? taskFrom(row) : null;
      if (!task) {
        // `null`: the provider has no such machine any more, which is what was asked.
        task = await driver.remove(ref);
        if (task) await kit.step(row, "remove", task);
      }
      if (task) {
        const outcome = await kit.wait(row, driver, task, REMOVE_MS, generation);
        if (!outcome.ok) return kit.finish(row, provider, driver, outcome.error, generation);
      }
      await kit.step(row, "release", null);
    }
    if (row.operationStep === "release") {
      if (!kit.current(row, generation)) return;
      // The machine is gone; the host row (and with it its tokens and its settings) follows.
      await this.release(row);
      await kit.record(row, provider, null);
    }
  }

  /**
   * Off, whatever it was. A hibernated machine is locked by its saved memory and cannot be
   * deleted as it is, so it is woken first and then stopped.
   */
  private async powerOff(row: HostVm, driver: VmProviderDriver, ref: VmRef, generation: number, kit: VmStepKit): Promise<StepOutcome> {
    for (let round = 0; round < 3; round++) {
      if (row.operationTask) {
        const outcome = await kit.wait(row, driver, taskFrom(row), START_MS, generation);
        if (!outcome.ok) return outcome;
        await kit.step(row, "stop", null);
      }
      const observed = await driver.status(ref);
      if (!observed || observed.state === "stopped") return { ok: true };
      await kit.step(row, "stop", await driver.power(ref, observed.state === "hibernated" ? "start" : "stop"));
    }
    return { ok: false, error: "VM_DELETE_FAILED" };
  }
}
