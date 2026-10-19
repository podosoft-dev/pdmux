import { FLEET_SETTING_FALLBACK } from "#lib/dashboard/fleet-settings.js";
import type { FleetScopeView, FleetSettingsView, HostView } from "#lib/dashboard/types.js";
import type { HostSettingsData, SettingsShellData, FleetPanelData } from "./types.js";

export async function settingsRead<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { signal });
  if (!response.ok) throw new Error("SETTINGS_UNAVAILABLE");
  return response.json() as Promise<T>;
}
export async function fleetPanelData(data: SettingsShellData, target: "local" | "server", signal: AbortSignal): Promise<FleetPanelData> {
  const prefix = target === "server" ? "/desktop/server" : "";
  const result: FleetPanelData = { ...data, settingsTarget: target, settingsData: { fleet: FLEET_SETTING_FALLBACK, fleetOk: false, canManage: false }, settingsHosts: [] };
  if (target === "server" && !data.desktopStatus.connected) return result;
  const [fleet, scope, hosts] = await Promise.all([
    settingsRead<FleetSettingsView>(`${prefix}/fleet/settings`, signal),
    settingsRead<FleetScopeView>(`${prefix}/fleet/scope`, signal),
    settingsRead<HostView[]>(`${prefix}/hosts`, signal),
  ]);
  return { ...result, settingsData: { fleet: { ...FLEET_SETTING_FALLBACK, ...fleet }, fleetOk: true, canManage: scope.canManage }, settingsHosts: hosts };
}
export async function hostPanelData(id: string, signal: AbortSignal): Promise<HostSettingsData> {
  const path = `/hosts/${encodeURIComponent(id)}`;
  // Credential/exposure collections are intentionally unavailable for a mirrored
  // server host. Keep its readable details usable without granting those operations.
  const optional = async <T>(route: string, fallback: T): Promise<T> => {
    try { return await settingsRead<T>(route, signal); }
    catch (error) { if (signal.aborted) throw error; return fallback; }
  };
  const [host, services, gitRoots, repos, tokens, exposures, cloudflare, scope, fleet] = await Promise.all([
    settingsRead<HostSettingsData["host"]>(path, signal),
    optional<HostSettingsData["services"]>(`${path}/services`, []),
    optional<HostSettingsData["gitRoots"]>(`${path}/git-roots`, []),
    optional<HostSettingsData["repos"]>(`${path}/repos`, []),
    optional<HostSettingsData["tokens"]>(`${path}/tokens`, []),
    optional<HostSettingsData["exposures"]>(`${path}/exposures`, []),
    optional<HostSettingsData["cloudflare"]>("/integrations/cloudflare", null),
    optional<FleetScopeView>("/fleet/scope", { personal: false, canManage: false }),
    optional<FleetSettingsView>("/fleet/settings", FLEET_SETTING_FALLBACK),
  ]);
  return { host, services, gitRoots, repos, tokens, exposures, cloudflare, fleetGitRoots: fleet.gitRoots ?? [], gitIntervalSec: fleet.gitIntervalSec ?? 120, canManage: scope.canManage && !host.origin?.readOnly };
}
