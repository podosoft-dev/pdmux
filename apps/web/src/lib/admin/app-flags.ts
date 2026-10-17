import type { AppFlagSetting } from "./registry.svelte.js";

/**
 * Application flags the admin Settings page shows, one switch each, on an
 * Application tab after PodoKit's tabs. `flag` is a key of `APP_FLAG_DEFAULTS`
 * in the API's owned `apps/api/src/settings/app-flags.ts`; the label and
 * description come from the app-owned `i18n/catalogs/app/*.json`.
 * PodoKit creates this file once and never overwrites it.
 */
export const APP_FLAG_SETTINGS: readonly AppFlagSetting[] = [
  { flag: "mcpEnabled", label: (t) => t.settings.mcpEnabled, description: (t) => t.settings.mcpEnabledDesc },
];
