import { AppException } from "../../common/app-exception";
import type {
  CloneSpec,
  ObservedVm,
  ProviderTask,
  TaskResult,
  VmAction,
  VmCatalog,
  VmProviderConfig,
  VmProviderDriver,
  VmRef,
  VmSettings,
  VmState,
} from "../vm-provider";
import { ProxmoxClient } from "./proxmox.client";

/** How long a guest gets to power off by itself before the task gives up. */
const SHUTDOWN_TIMEOUT_SEC = 180;

type Row = Record<string, unknown>;

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((row): row is Row => row !== null && typeof row === "object") : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tagsOf(value: unknown): string[] {
  return text(value).split(/[;,\s]+/).filter(Boolean);
}

/**
 * Proxmox's power state, folded into ours.
 *
 * ⚠ A HIBERNATED MACHINE IS "STOPPED" WITH A LOCK. Proxmox has no hibernated status: the VM is
 * stopped and its config carries `lock: suspended` until the next start resumes it. Right
 * after the suspend, `/cluster/resources` can still say `running` for a few seconds while the
 * lock is already there (measured on 9.2.21), so the lock decides, whatever the status says.
 */
export function proxmoxState(status: string, lock: string, qmpstatus = ""): VmState {
  if (lock === "suspended") return "hibernated";
  if (status === "running") return qmpstatus === "paused" ? "paused" : "running";
  if (status === "stopped") return "stopped";
  return "unknown";
}

function observed(row: Row, fallbackNode?: string): ObservedVm | null {
  const vmid = count(row.vmid);
  const node = text(row.node) || fallbackNode || "";
  if (vmid === null || !node) return null;
  const maxmem = count(row.maxmem);
  return {
    ref: { node, vmid },
    name: text(row.name),
    state: proxmoxState(text(row.status), text(row.lock), text(row.qmpstatus)),
    tags: tagsOf(row.tags),
    template: row.template === 1 || row.template === true,
    memoryMb: maxmem === null ? null : Math.round(maxmem / 1024 / 1024),
    cores: count(row.maxcpu) ?? count(row.cpus),
  };
}

/** A UPID carries the node it runs on: `UPID:<node>:<pid>:…`. */
export function taskOf(value: unknown): ProviderTask {
  const id = text(value);
  const node = id.split(":")[1] ?? "";
  if (!id.startsWith("UPID:") || !node) {
    throw new AppException("VM_PROVIDER_INVALID_RESPONSE", "The provider returned an invalid task id", 502);
  }
  return { id, node };
}

const base64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

/**
 * `smbios1` with our two fields set (or cleared), every other field kept.
 *
 * The VM's `uuid` lives in the same option and is the machine's identity inside the guest, so
 * the option is rewritten field by field — sending only `serial`/`sku` would drop it.
 */
export function smbiosWith(current: string, firmware: { serial: string; sku: string } | null): string {
  const fields = new Map<string, string>();
  for (const part of current.split(",")) {
    const separator = part.indexOf("=");
    if (separator > 0) fields.set(part.slice(0, separator), part.slice(separator + 1));
  }
  const encoded = fields.get("base64") === "1";
  // Our fields are always written encoded; any other field already there is converted once.
  if (!encoded) {
    for (const [key, value] of fields) {
      if (key !== "uuid" && key !== "base64") fields.set(key, base64(value));
    }
  }
  fields.delete("serial");
  fields.delete("sku");
  fields.delete("base64");
  if (firmware) {
    fields.set("serial", base64(firmware.serial));
    fields.set("sku", base64(firmware.sku));
  }
  const rest = [...fields].filter(([key]) => key !== "uuid");
  const uuid = fields.get("uuid");
  return [
    ...(uuid ? [`uuid=${uuid}`] : []),
    ...(rest.length > 0 ? ["base64=1"] : []),
    ...rest.map(([key, value]) => `${key}=${value}`),
  ].join(",");
}

const POWER_PATHS: Record<VmAction, string> = {
  start: "start",
  hibernate: "suspend",
  shutdown: "shutdown",
  stop: "stop",
  reboot: "reboot",
  reset: "reset",
};

/** The Proxmox VE driver. Every Proxmox path and field name lives in this file and the client. */
export class ProxmoxDriver implements VmProviderDriver {
  readonly kind = "proxmox" as const;

  constructor(private readonly client: ProxmoxClient) {}

  static create(config: VmProviderConfig, secret: string, requestFetch?: typeof fetch): ProxmoxDriver {
    return new ProxmoxDriver(new ProxmoxClient({
      baseUrl: config.baseUrl,
      tokenId: config.tokenId,
      secret,
      caCertificate: config.caCertificate,
    }, requestFetch));
  }

  async test(): Promise<{ version: string }> {
    const version = await this.client.get<Row>("/version");
    return { version: text(version?.version) };
  }

  async discover(): Promise<VmCatalog> {
    const nodes = rows(await this.client.get("/nodes")).map((row) => ({
      name: text(row.node),
      online: text(row.status) === "online",
    })).filter((node) => node.name);
    const templates = rows(await this.client.get("/cluster/resources", { type: "vm" }))
      .filter((row) => row.template === 1)
      .flatMap((row) => {
        const vm = observed(row);
        return vm ? [{ ref: vm.ref, name: vm.name }] : [];
      });
    const storages: VmCatalog["storages"] = [];
    const bridges: VmCatalog["bridges"] = [];
    for (const node of nodes.filter((entry) => entry.online)) {
      const path = `/nodes/${encodeURIComponent(node.name)}`;
      for (const row of rows(await this.client.get(`${path}/storage`, { enabled: 1 }))) {
        storages.push({ node: node.name, id: text(row.storage), type: text(row.type), content: text(row.content).split(",").filter(Boolean) });
      }
      for (const row of rows(await this.client.get(`${path}/network`, { type: "any_bridge" }))) {
        bridges.push({ node: node.name, name: text(row.iface) });
      }
    }
    const pools = rows(await this.client.get("/pools")).map((row) => text(row.poolid)).filter(Boolean);
    return { nodes, templates, storages, bridges, pools };
  }

  async list(): Promise<ObservedVm[]> {
    return rows(await this.client.get("/cluster/resources", { type: "vm" }))
      .filter((row) => text(row.type) === "qemu")
      .flatMap((row) => {
        const vm = observed(row);
        return vm ? [vm] : [];
      });
  }

  async status(ref: VmRef): Promise<ObservedVm | null> {
    try {
      const row = await this.client.get<Row>(`${this.vmPath(ref)}/status/current`);
      return row ? observed({ ...row, vmid: ref.vmid }, ref.node) : null;
    } catch (error) {
      // A machine outside these credentials' reach answers 403, a deleted one 500 — to us both
      // mean "not a machine we can act on"; the reconcile's full list tells them apart.
      if (error instanceof AppException && (error.code === "VM_NOT_FOUND" || error.code === "VM_PROVIDER_FORBIDDEN")) return null;
      throw error;
    }
  }

  async power(ref: VmRef, action: VmAction, options: { timeoutSec?: number } = {}): Promise<ProviderTask> {
    const params = action === "hibernate"
      ? { todisk: 1 }
      : action === "shutdown"
        ? { timeout: options.timeoutSec ?? SHUTDOWN_TIMEOUT_SEC }
        : {};
    return taskOf(await this.client.post(`${this.vmPath(ref)}/status/${POWER_PATHS[action]}`, params));
  }

  async clone(spec: CloneSpec): Promise<ProviderTask> {
    return taskOf(await this.client.post(`${this.vmPath(spec.template)}/clone`, {
      newid: spec.vmid,
      name: spec.name,
      pool: spec.pool ?? undefined,
      full: spec.full,
      // A target storage is only meaningful for a full copy; a linked clone stays beside its base.
      storage: spec.full && spec.storage ? spec.storage : undefined,
    }));
  }

  async configure(ref: VmRef, settings: VmSettings): Promise<void> {
    const params: Record<string, string | number | undefined> = {
      name: settings.name,
      cores: settings.cores,
      memory: settings.memoryMb,
      balloon: settings.balloonMb,
      tags: settings.tags ? settings.tags.join(";") : undefined,
      description: settings.description,
    };
    if (settings.firmware !== undefined) {
      const config = await this.client.get<Row>(`${this.vmPath(ref)}/config`);
      params.smbios1 = smbiosWith(text(config?.smbios1), settings.firmware);
    }
    await this.client.put(`${this.vmPath(ref)}/config`, params);
  }

  async remove(ref: VmRef): Promise<ProviderTask | null> {
    const result = await this.client.delete(this.vmPath(ref), { purge: 1, "destroy-unreferenced-disks": 1 });
    return result === null ? null : taskOf(result);
  }

  async backup(ref: VmRef, storage: string, notes: string): Promise<ProviderTask> {
    return taskOf(await this.client.post(`/nodes/${encodeURIComponent(ref.node)}/vzdump`, {
      vmid: ref.vmid,
      storage,
      mode: "snapshot",
      "notes-template": notes,
    }));
  }

  async lastBackupAt(vmid: number, node: string, storage: string): Promise<number | null> {
    const backups = rows(await this.client.get(
      `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content`,
      { content: "backup", vmid },
    ));
    const times = backups.map((row) => count(row.ctime)).filter((value): value is number => value !== null);
    return times.length > 0 ? Math.max(...times) * 1000 : null;
  }

  async vmidFree(vmid: number): Promise<boolean> {
    try {
      await this.client.get("/cluster/nextid", { vmid });
      return true;
    } catch (error) {
      if (error instanceof AppException && error.code === "VM_ID_TAKEN") return false;
      throw error;
    }
  }

  async task(task: ProviderTask): Promise<TaskResult> {
    const status = await this.client.get<Row>(`/nodes/${encodeURIComponent(task.node)}/tasks/${encodeURIComponent(task.id)}/status`);
    if (text(status?.status) !== "stopped") return { done: false };
    const exit = text(status?.exitstatus);
    // vzdump ends "WARNINGS: n" when it finished with something to say; the backup exists.
    if (exit === "OK" || exit.startsWith("WARNINGS")) return { done: true, ok: true };
    return { done: true, ok: false, error: taskError(exit) };
  }

  private vmPath(ref: VmRef): string {
    return `/nodes/${encodeURIComponent(ref.node)}/qemu/${ref.vmid}`;
  }
}

/** A failed task as a code. The provider's text stays here: it names nodes and storage. */
export function taskError(exit: string): string {
  if (/got timeout|timeout/i.test(exit)) return "VM_TASK_TIMEOUT";
  if (/already running/i.test(exit)) return "VM_ALREADY_RUNNING";
  if (/not running/i.test(exit)) return "VM_NOT_RUNNING";
  if (/lock/i.test(exit)) return "VM_LOCKED";
  return "VM_TASK_FAILED";
}
