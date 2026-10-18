import type { PageServerLoad } from "./$types";
import type { FleetSettingsView, FleetScopeView, HostView } from "#lib/dashboard/types.js";
import { FLEET_SETTING_FALLBACK } from "#lib/dashboard/fleet-settings.js";
import type { SettingsTarget } from "#lib/dashboard/api.js";

export const load: PageServerLoad = async ({ parent, url, fetch }) => {
  const data = await parent();
  const target: SettingsTarget = data.desktopStatus.local && url.searchParams.get("scope") === "server" ? "server" : "local";
  if (target === "local") return { settingsTarget: target, settingsData: { fleet: data.fleet, fleetOk: data.fleetOk, canManage: data.canManage }, settingsHosts: [] as HostView[] };
  const unavailable = { settingsTarget: target, settingsData: { fleet: FLEET_SETTING_FALLBACK, fleetOk: false, canManage: false }, settingsHosts: [] as HostView[] };
  if (!data.desktopStatus.connected) return unavailable;
  try {
    const responses = await Promise.all(["/fleet/settings", "/fleet/scope", "/hosts"].map(path => fetch(`/api/desktop/server${path}`)));
    if (responses.some(response => !response.ok)) return unavailable;
    const fleet = await responses[0]!.json() as FleetSettingsView;
    const scope = await responses[1]!.json() as FleetScopeView;
    const hosts = await responses[2]!.json() as HostView[];
    return { settingsTarget: target, settingsData: { fleet: { ...FLEET_SETTING_FALLBACK, ...fleet }, fleetOk: true, canManage: scope.canManage }, settingsHosts: hosts };
  } catch { return unavailable; }
};
