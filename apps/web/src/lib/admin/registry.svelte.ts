import type { Component } from "svelte";
import type { Messages } from "#lib/i18n/messages.js";
// Modules import their nav-entry icons here.
// podokit:begin:admin-nav-imports
// podokit:end:admin-nav-imports

// Module-driven admin menu registry. Modules append their sidebar nav entries and
// settings tabs at the markers below via `podo add` injection, so the admin menu
// grows and shrinks with the installed module set — no edits to admin-sidebar or
// the settings page. Empty until a module registers.

/** A sidebar nav entry contributed by a module: a link, a label resolved from the
 *  current locale (from the module's own i18n block), and an icon. */
export type AdminNavEntry = {
  href: string;
  label: (t: Messages) => string;
  icon: Component;
  adminOnly?: boolean;
};

/** A settings tab contributed by a module: a tab value, a label resolved from the
 *  current locale, and the panel component. */
export type AdminSettingsSection = {
  value: string;
  label: (t: Messages) => string;
  component: Component;
};

export const moduleNavEntries: AdminNavEntry[] = [
  // podokit:begin:admin-nav-entries
  // podokit:end:admin-nav-entries
];

export const moduleSettingsSections: AdminSettingsSection[] = [
  // podokit:begin:admin-settings
  // podokit:end:admin-settings
];
