/**
 * What pdmux asks of a VM provider, and nothing about any one provider.
 *
 * The state machine, the routes and the screens speak only these types. A provider is a
 * driver behind them — Proxmox VE first — so another platform is a new driver, not a change
 * to the rest. A driver is built per connection with that connection's credentials and is
 * never cached across connections.
 */

/** A power change. `hibernate` saves memory to disk and the next `start` resumes it. */
export const VM_ACTIONS = ["start", "hibernate", "shutdown", "stop", "reboot", "reset"] as const;
export type VmAction = (typeof VM_ACTIONS)[number];

/**
 * How the provider sees a machine.
 *
 * `missing` is a machine pdmux knows about and the provider no longer has; `unknown` is a
 * provider that could not be asked. They are different on screen: one is gone, the other
 * may be fine.
 */
export type VmState = "running" | "hibernated" | "stopped" | "paused" | "unknown" | "missing";

export type VmProviderKind = "proxmox";

/** What a new machine gets unless someone says otherwise, per platform. */
export interface VmProviderDefaults {
  cores: number;
  memoryMb: number;
  /** The boot disk is grown to this when the template's is smaller. */
  diskGb: number;
  vmidMin: number;
  vmidMax: number;
  fullClone: boolean;
}

/**
 * The platform defaults, so a person connecting a provider types its address and credentials
 * and nothing else. Template, pool, node and storage default to "find it" rather than a value:
 * a template tagged `pdmux-template`, a pool named `pdmux` if the cluster has one, the
 * template's node and storage.
 */
export const PROVIDER_DEFAULTS: Record<VmProviderKind, VmProviderDefaults> = {
  proxmox: { cores: 4, memoryMb: 16_384, diskGb: 64, vmidMin: 500, vmidMax: 599, fullClone: false },
};

/** A template carrying this tag is used when the provider names none. */
export const TEMPLATE_TAG = "pdmux-template";
/** A pool with this name is used when the provider names none. */
export const DEFAULT_POOL = "pdmux";

/** Where a machine lives at its provider. Opaque to everything but the driver. */
export interface VmRef {
  node: string;
  vmid: number;
}

export interface ObservedVm {
  ref: VmRef;
  name: string;
  state: VmState;
  tags: string[];
  template: boolean;
  memoryMb: number | null;
  cores: number | null;
}

/** A long-running provider job. Proxmox answers most writes with one (a UPID). */
export interface ProviderTask {
  id: string;
  node: string;
}

export type TaskResult = { done: false } | { done: true; ok: true } | { done: true; ok: false; error: string };

export interface VmCatalog {
  nodes: { name: string; online: boolean }[];
  templates: { ref: VmRef; name: string; tags: string[] }[];
  storages: { node: string; id: string; type: string; content: string[] }[];
  bridges: { node: string; name: string }[];
  pools: string[];
}

export interface VmSettings {
  name?: string;
  cores?: number;
  memoryMb?: number;
  /** Minimum memory for the balloon device; equal to `memoryMb` keeps it a hard allocation. */
  balloonMb?: number;
  tags?: string[];
  description?: string;
  /**
   * Values the machine can read from its firmware (SMBIOS), which is how a new VM learns its
   * enrollment code without the server reaching into it. `null` clears them.
   */
  firmware?: { serial: string; sku: string } | null;
}

export interface CloneSpec {
  template: VmRef;
  vmid: number;
  name: string;
  pool: string | null;
  /** Full copy instead of a linked clone, for storage that cannot link. */
  full: boolean;
  storage: string | null;
}

export interface VmProviderDriver {
  readonly kind: VmProviderKind;
  /** Reaches the provider with these credentials; answers its version. */
  test(): Promise<{ version: string }>;
  discover(): Promise<VmCatalog>;
  /** Every machine these credentials can see, in one call — the reconcile reads this. */
  list(): Promise<ObservedVm[]>;
  /** One machine, fresh. `null` when the provider has no such machine. */
  status(ref: VmRef): Promise<ObservedVm | null>;
  power(ref: VmRef, action: VmAction, options?: { timeoutSec?: number }): Promise<ProviderTask>;
  clone(spec: CloneSpec): Promise<ProviderTask>;
  configure(ref: VmRef, settings: VmSettings): Promise<void>;
  /** Grow the boot disk to `sizeGb`. `null` when it is already that large (disks only grow). */
  resizeDisk(ref: VmRef, sizeGb: number): Promise<ProviderTask | null>;
  remove(ref: VmRef): Promise<ProviderTask | null>;
  backup(ref: VmRef, storage: string, notes: string): Promise<ProviderTask>;
  /** Epoch ms of the newest backup of this id in `storage`, `null` for none. */
  lastBackupAt(vmid: number, node: string, storage: string): Promise<number | null>;
  /** True when no machine anywhere at the provider holds this id — including ones these credentials cannot see. */
  vmidFree(vmid: number): Promise<boolean>;
  task(task: ProviderTask): Promise<TaskResult>;
}

/** Non-secret connection settings. Stored as JSON; never contains the credential. */
export interface VmProviderConfig {
  baseUrl: string;
  tokenId: string;
  /** PEM of the CA that signs the provider's certificate; `null` trusts the system store. */
  caCertificate: string | null;
  defaults: {
    node: string | null;
    template: VmRef | null;
    storage: string | null;
    pool: string | null;
    vmidMin: number;
    vmidMax: number;
    cores: number;
    memoryMb: number;
    /** Absent on connections saved before disk sizing existed: then the template's size stays. */
    diskGb?: number | null;
    fullClone: boolean;
  };
  /** Only machines carrying this tag may be hibernated; `null` allows every machine. */
  sleepRequiresTag: string | null;
  /** Back up before hibernating when the newest backup in this storage is older than a day. */
  backupBeforeSleep: string | null;
  /**
   * The pdmux address a machine created here enrolls with. Machines live on the provider's
   * network, which may reach pdmux by another name than a browser does; `null` uses the
   * server's own public address.
   */
  enrollUrl?: string | null;
}

export type VmDriverFactory = (kind: VmProviderKind, config: VmProviderConfig, secret: string) => VmProviderDriver;
