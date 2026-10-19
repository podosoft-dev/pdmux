import type { DesktopStatusView } from "#lib/desktop.js";
import type { AgentTokenView, CloudflareIntegrationView, FleetSettingsView, HostGitRootView, HostServiceView, HostView, RepoRow, ServiceExposureView } from "#lib/dashboard/types.js";

export interface SettingsShellData {
  fleet: FleetSettingsView;
  fleetOk: boolean;
  canManage: boolean;
  desktopStatus: DesktopStatusView;
}
export interface FleetPanelData extends SettingsShellData {
  settingsTarget: "local" | "server";
  settingsData: Pick<SettingsShellData, "fleet" | "fleetOk" | "canManage">;
  settingsHosts: HostView[];
}
export interface HostSettingsData {
  host: HostView;
  services: HostServiceView[];
  gitRoots: HostGitRootView[];
  repos: RepoRow[];
  tokens: AgentTokenView[];
  exposures: ServiceExposureView[];
  cloudflare: CloudflareIntegrationView | null;
  fleetGitRoots: string[];
  gitIntervalSec: number;
  canManage: boolean;
}
export interface ConnectionPanelData {
  status: DesktopStatusView;
  agents: { version: string; artifacts: Array<{ file: string; bytes: number; available: boolean; bundled: boolean }> } | null;
}
