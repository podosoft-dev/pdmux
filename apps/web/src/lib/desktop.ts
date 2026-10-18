import type { SyncConflict } from "@pdmux/desktop-protocol";

export interface DesktopStatusView {
  local: boolean;
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
  connect(url: string): Promise<unknown>;
  authenticate(code: string): Promise<unknown>;
  workspace(id: string | null): Promise<unknown>;
  disconnect(): Promise<unknown>;
}
export type DesktopAction = "backup" | "open-data" | "check-updates";
export interface LocalAgentStatus { phase: "starting" | "ready" | "failed" | "stopped"; hostId?: string; code?: string }
export function desktopLocalAgent(): { status(): Promise<LocalAgentStatus>; retry(): Promise<LocalAgentStatus> } | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { pdmuxDesktop?: { localAgent?: { status(): Promise<LocalAgentStatus>; retry(): Promise<LocalAgentStatus> } } }).pdmuxDesktop?.localAgent;
}
export function desktopActions(): { run(action: DesktopAction): Promise<void> } | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { pdmuxDesktop?: { actions?: { run(action: DesktopAction): Promise<void> } } }).pdmuxDesktop?.actions;
}
export function desktopConnection(): DesktopConnectionBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { pdmuxDesktop?: { connection?: DesktopConnectionBridge } }).pdmuxDesktop?.connection;
}
