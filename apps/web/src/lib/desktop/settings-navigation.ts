export function desktopSettingsTab(path: string, search: Pick<URLSearchParams, "get">): string | null {
  if (path === "/preferences") { const tab = search.get("tab"); return tab === "advanced" || tab === "general" ? tab : "terminal"; }
  if (path === "/hosts" || path.startsWith("/hosts/")) return "hosts";
  if (path === "/settings") return "fleet";
  if (path === "/access") return "access";
  if (path === "/connection") return "connection";
  return null;
}

export function localDesktopPage(data: unknown): boolean {
  if (!data || typeof data !== "object" || !("desktopStatus" in data)) return false;
  const status = data.desktopStatus;
  return !!status && typeof status === "object" && "local" in status && status.local === true;
}
