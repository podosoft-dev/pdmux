import { createConfigStore, type ConfigStore } from "@podosoft/podokit-auth";
import { flagsFrom } from "../settings/flag-defaults";
import { readAppSettings, readAuthConfig, readConfigVersions } from "./db";
import { signupOpenFrom } from "./feature-gate";

/** A store over this app's auth_config and app_setting tables. */
export function createAuthConfigStore(): ConfigStore {
  return createConfigStore({
    list: readAuthConfig,
    listSettings: readAppSettings,
    versions: readConfigVersions,
  });
}

// One process-wide snapshot serves the auth runtime, feature gate, settings
// service, mailer, capabilities endpoint, and audit toggle. Local writes
// invalidate it; other replicas see a change at their next version probe.
export const authConfigStore = createAuthConfigStore();

export const featureFlags = authConfigStore.selectSettings(flagsFrom);
export const isSignupOpen = authConfigStore.selectSettings(signupOpenFrom);
