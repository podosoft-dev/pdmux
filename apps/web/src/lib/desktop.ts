import type { SyncConflict } from "@pdmux/desktop-protocol";

export interface DesktopStatusView {
  local: boolean;
  user?: { id: string; name: string; email: string; image?: string | null; role?: string | null } | null;
  connected?: boolean;
  bridgeConnected?: boolean;
  serverUrl?: string | null;
  scopeId?: string | null;
  organizations?: Array<{ id: string; name: string }>;
  lastSync?: string | null;
  error?: string | null;
  conflicts?: SyncConflict[];
}

export interface DesktopConnectionBridge {
  connect(url?: string): Promise<unknown>;
  authenticate(code: string): Promise<unknown>;
  workspace(id: string | null): Promise<unknown>;
  disconnect(): Promise<unknown>;
  open(page: "account" | "admin"): Promise<unknown>;
  onChanged?(listener: () => void): () => void;
}
export type DesktopAction = "backup" | "open-data" | "check-updates";
export interface LocalAgentStatus { phase: "starting" | "ready" | "failed" | "stopped"; hostId?: string; code?: string }
export function desktopLocalAgent(): { status(): Promise<LocalAgentStatus>; retry(): Promise<LocalAgentStatus> } | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { pdmuxDesktop?: { localAgent?: { status(): Promise<LocalAgentStatus>; retry(): Promise<LocalAgentStatus> } } }).pdmuxDesktop?.localAgent;
}
interface DesktopActions { run(action: DesktopAction): Promise<void>; onSettings?(listener: () => void): () => void }
export function desktopActions(): DesktopActions | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { pdmuxDesktop?: { actions?: DesktopActions } }).pdmuxDesktop?.actions;
}
export function desktopConnection(): DesktopConnectionBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { pdmuxDesktop?: { connection?: DesktopConnectionBridge } }).pdmuxDesktop?.connection;
}

export function desktopPreferences(): { read(): Promise<unknown>; save(value: unknown): Promise<unknown> } | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { pdmuxDesktop?: { preferences?: { read(): Promise<unknown>; save(value: unknown): Promise<unknown> } } }).pdmuxDesktop?.preferences;
}
