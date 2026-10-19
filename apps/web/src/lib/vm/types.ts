/**
 * The VM provider API as the web app reads it. Mirrors `apps/api/src/vm` — the server is
 * the authority; these are the shapes it sends.
 */
export const VM_ACTIONS = ["start", "hibernate", "shutdown", "stop", "reboot", "reset"] as const;
export type VmAction = (typeof VM_ACTIONS)[number];
export type VmState = "running" | "hibernated" | "stopped" | "paused" | "unknown" | "missing";
export type VmOperationKind = VmAction | "create" | "delete" | "enroll";

/** `HostView.vm` — the machine behind a host, its one change in flight, and who asked. */
export interface HostVmView {
  provider: { id: string; kind: "proxmox"; name: string };
  origin: "created" | "linked";
  name: string;
  location: string;
  externalId: string;
  state: VmState;
  observedAt: string | null;
  operation: {
    action: VmOperationKind;
    step: string | null;
    startedAt: string;
    requestedBy: { id: string | null; name: string | null };
  } | null;
  error: { code: string; at: string } | null;
  /** What the machine's STATE allows now; who may do it is `canManage`'s business. */
  available: Record<VmAction | "delete" | "enroll", boolean>;
}

export interface VmProviderView {
  id: string;
  kind: "proxmox";
  name: string;
  baseUrl: string;
  tokenId: string;
  caFingerprint: string | null;
  defaults: {
    node: string | null;
    template: { node: string; vmid: number } | null;
    storage: string | null;
    pool: string | null;
    vmidMin: number;
    vmidMax: number;
    cores: number;
    memoryMb: number;
    fullClone: boolean;
  };
  sleepRequiresTag: string | null;
  backupBeforeSleep: string | null;
  enrollUrl: string | null;
  lastTestedAt: string | null;
  lastErrorCode: string | null;
  machineCount: number;
}

export interface VmProviderInput {
  kind: "proxmox";
  name: string;
  baseUrl: string;
  tokenId: string;
  tokenSecret: string;
  caCertificate: string | null;
  defaultNode: string | null;
  defaultTemplateNode: string | null;
  defaultTemplateVmid: number | null;
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

export interface VmCatalog {
  nodes: { name: string; online: boolean }[];
  templates: { ref: { node: string; vmid: number }; name: string }[];
  storages: { node: string; id: string; type: string; content: string[] }[];
  bridges: { node: string; name: string }[];
  pools: string[];
}

/** `POST /vm/machines`: a machine from a template and the host it becomes. Sizes default to the provider's. */
export interface CreateVmInput {
  providerId: string;
  label: string;
  templateNode: string | null;
  templateVmid: number | null;
  cores: number | null;
  memoryMb: number | null;
  /** One per dialog: a retried submit makes one machine. */
  idempotencyKey: string;
}

export interface CreatedVm {
  hostId: string;
  label: string;
  vm: HostVmView;
}
