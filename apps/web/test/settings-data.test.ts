import { afterEach, describe, expect, it, vi } from "vitest";
import { FLEET_SETTING_FALLBACK } from "../src/lib/dashboard/fleet-settings.js";
import { fleetPanelData, hostPanelData } from "../src/lib/settings/settings-data.js";
import { settingsLocation } from "../src/lib/settings/settings-state.svelte.js";

afterEach(() => vi.unstubAllGlobals());

describe("[TC-PDDESKTOP-026] modal settings data", () => {
  it("maps old bookmarks and scope selection into the same dialog", () => {
    expect(settingsLocation(new URL("https://example.test/hosts/host-id"))).toEqual({ tab: "hosts", host: "host-id" });
    expect(settingsLocation(new URL("https://example.test/settings?scope=server"))).toEqual({ tab: "fleet", target: "server" });
    expect(settingsLocation(new URL("https://example.test/?preferences=terminal"))).toMatchObject({ tab: "terminal" });
    expect(settingsLocation(new URL("https://example.test/account"))).toBeNull();
  });
  it("never requests server settings when the desktop is signed out", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const result = await fleetPanelData({ fleet: FLEET_SETTING_FALLBACK, fleetOk: true, canManage: true, desktopStatus: { local: true, connected: false } }, "server", new AbortController().signal);
    expect(result.settingsData).toMatchObject({ fleetOk: false, canManage: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reads server settings and permissions from their own backend", async () => {
    const fetch = vi.fn(async (path: string) => Response.json(path.endsWith("/fleet/settings") ? { heartbeatSec: 37 } : path.endsWith("/fleet/scope") ? { canManage: false } : [])); vi.stubGlobal("fetch", fetch);
    const result = await fleetPanelData({ fleet: FLEET_SETTING_FALLBACK, fleetOk: true, canManage: true, desktopStatus: { local: true, connected: true } }, "server", new AbortController().signal);
    expect(result.settingsData).toMatchObject({ fleet: { heartbeatSec: 37 }, fleetOk: true, canManage: false });
    expect(fetch.mock.calls.every(([path]) => path.startsWith("/api/desktop/server/"))).toBe(true);
  });
  it("keeps a mirrored host readable when credential collections are denied", async () => {
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/api/hosts/remote") return Response.json({ id: "remote", origin: { readOnly: true } });
      if (path === "/api/fleet/scope") return Response.json({ canManage: true });
      return new Response(null, { status: 403 });
    }));
    const result = await hostPanelData("remote", new AbortController().signal);
    expect(result).toMatchObject({ host: { id: "remote" }, tokens: [], canManage: false });
  });
});
