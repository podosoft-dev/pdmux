import type { AdminNavEntry } from "./registry.svelte.js";

/**
 * Application-owned admin sidebar entries. The sidebar shows them after PodoKit's
 * own pages and before module entries and Settings, for example
 * `{ href: "/admin/reports", label: (t) => t.reports.nav, icon: ChartColumnIcon, adminOnly: true }`
 * with the label in the app-owned `i18n/catalogs/app/*.json` and the icon from
 * `@lucide/svelte/icons/*`. `adminOnly` hides an entry from other roles.
 * PodoKit creates this file once and never overwrites it.
 */
export const APP_ADMIN_NAV: readonly AdminNavEntry[] = [];
