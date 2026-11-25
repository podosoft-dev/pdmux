import { createConfigStore, type AuthConfigDefaults, type ConfigStore } from "@podosoft/podokit-auth";
import { flagsFrom } from "../settings/flag-defaults";
import { readAppSettings, readAuthConfig, readConfigVersions } from "./db";
import { signupOpenFrom } from "./feature-gate";

/** Values used when neither the auth_config table nor the environment sets one.
 *  Other PodoKit modules add theirs below the marker. */
export const AUTH_CONFIG_DEFAULTS: AuthConfigDefaults = {
  appName: "PDMux",
  // podokit:begin:auth-config-defaults
  auditLog: true,
  // podokit:end:auth-config-defaults
};

/** Optional modules that serve auth-related routes, such as the audit log.
 *  Each adds its name below the marker; a capability whose module is missing
 *  stays off even when the database or environment switches it on. */
export const AUTH_FEATURE_MODULES: ReadonlySet<string> = new Set<string>([
  // podokit:begin:auth-feature-modules
  "audit-log",
  // podokit:end:auth-feature-modules
]);

/** Whether the audit log is recorded and listed: on, and its module installed. */
export function auditLogAvailable(enabled: boolean, modules: ReadonlySet<string> = AUTH_FEATURE_MODULES): boolean {
  return enabled && modules.has("audit-log");
}

/** A store over this app's auth_config and app_setting tables. */
export function createAuthConfigStore(): ConfigStore {
  return createConfigStore({
    list: readAuthConfig,
    listSettings: readAppSettings,
    versions: readConfigVersions,
  }, {
    defaults: AUTH_CONFIG_DEFAULTS,
    // The site name from the admin Settings, when the admin dashboard stores one.
    appNameSetting: "site.name",
  });
}

// One process-wide snapshot serves the auth runtime, feature gate, settings
// service, mailer, capabilities endpoint, and audit toggle. Local writes
// invalidate it; other replicas see a change at their next version probe.
export const authConfigStore = createAuthConfigStore();

export const featureFlags = authConfigStore.selectSettings(flagsFrom);
export const isSignupOpen = authConfigStore.selectSettings(signupOpenFrom);
