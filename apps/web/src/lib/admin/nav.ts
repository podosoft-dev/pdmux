import LayoutDashboardIcon from "@lucide/svelte/icons/layout-dashboard";
import UsersIcon from "@lucide/svelte/icons/users";
import MonitorSmartphoneIcon from "@lucide/svelte/icons/monitor-smartphone";
import ScrollTextIcon from "@lucide/svelte/icons/scroll-text";
import Building2Icon from "@lucide/svelte/icons/building-2";
import SettingsIcon from "@lucide/svelte/icons/settings";
import { APP_ADMIN_NAV } from "./app-nav";
import { moduleNavEntries, type AdminNavEntry } from "./registry.svelte.js";

export type AdminNavCapabilities = { auditLog?: boolean; organization?: boolean };

/**
 * The admin sidebar entries a user may open: PodoKit's pages, the application's
 * entries from the app-owned app-nav.ts, module entries, then Settings.
 */
export function adminNavEntries(
  capabilities: AdminNavCapabilities | undefined,
  role: string | null | undefined,
): AdminNavEntry[] {
  const entries: AdminNavEntry[] = [
    { href: "/admin", label: (t) => t.nav.overview, icon: LayoutDashboardIcon },
    { href: "/admin/users", label: (t) => t.nav.users, icon: UsersIcon, adminOnly: true },
    { href: "/admin/sessions", label: (t) => t.nav.sessions, icon: MonitorSmartphoneIcon, adminOnly: true },
    ...(capabilities?.organization
      ? [{ href: "/admin/organizations", label: (t) => t.nav.organizations, icon: Building2Icon, adminOnly: true } satisfies AdminNavEntry]
      : []),
    ...(capabilities?.auditLog
      ? [{ href: "/admin/audit", label: (t) => t.nav.audit, icon: ScrollTextIcon, adminOnly: true } satisfies AdminNavEntry]
      : []),
    ...APP_ADMIN_NAV,
    ...moduleNavEntries,
    { href: "/admin/settings", label: (t) => t.nav.settings, icon: SettingsIcon, adminOnly: true },
  ];
  return entries.filter((entry) => !entry.adminOnly || role === "admin");
}
