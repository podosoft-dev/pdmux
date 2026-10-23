import { APP_FLAG_DEFAULTS } from "./app-flags";

/** Admin-managed auth feature flags and their shipped defaults, followed by the
 *  application's flags from the owned app-flags.ts.
 *
 *  Kept free of framework/ORM imports so both SettingsService and the Better
 *  Auth feature gate (loaded by auth.ts, including when
 *  the better-auth CLI evaluates auth.ts for migrations) can import it safely.
 *
 *  The PodoKit defaults must match the rows seeded by the InitAppSettings
 *  migrations (InitAppSettings, SeedTeamsSetting). phoneNumber is off by default because real delivery needs an SMS
 *  provider. */
export type PodokitFeatureFlag = "twoFactor" | "magicLink" | "emailOtp" | "username" | "multiSession" | "phoneNumber" | "apiKey" | "passkey" | "organization" | "teams" | "oidcProvider" | "require2fa";

export type AppFlag = keyof typeof APP_FLAG_DEFAULTS;

export type FeatureFlag = PodokitFeatureFlag | AppFlag;

const PODOKIT_FLAG_DEFAULTS: Record<PodokitFeatureFlag, boolean> = {
  twoFactor: true,
  magicLink: true,
  emailOtp: true,
  username: true,
  multiSession: true,
  phoneNumber: false,
  apiKey: true,
  passkey: true,
  organization: true,
  // Teams inside organizations. Needs organizations on as well; off by default.
  teams: false,
  // Acting as an OIDC identity provider is an enterprise opt-in; off by default.
  oidcProvider: false,
  // Policy (not a feature endpoint): when on, every signed-in user must enrol in
  // two-factor before using the app. Enforced by AuthService + the web
  // enrolment gate — the feature gate ignores it (no endpoint prefix). Off by default.
  require2fa: false,
};

/** PodoKit's defaults with the application's; an application flag may not reuse a PodoKit name. */
export function mergeFlagDefaults<App extends Record<string, boolean>>(
  podokit: Record<PodokitFeatureFlag, boolean>,
  app: App,
): Record<PodokitFeatureFlag | keyof App, boolean> {
  const redefined = Object.keys(app).filter((flag) => flag in podokit);
  if (redefined.length > 0) {
    throw new Error(`app-flags.ts redefines PodoKit feature flags: ${redefined.join(", ")}`);
  }
  return { ...podokit, ...app };
}

export const FLAG_DEFAULTS: Record<FeatureFlag, boolean> = mergeFlagDefaults(PODOKIT_FLAG_DEFAULTS, APP_FLAG_DEFAULTS);

export const FEATURE_FLAGS = Object.keys(FLAG_DEFAULTS) as FeatureFlag[];

/** The application's flags, which the capabilities endpoint returns as `appFlags`. */
export const APP_FLAGS = Object.keys(APP_FLAG_DEFAULTS) as AppFlag[];

/** Stored values override the shipped defaults; a missing row keeps the default. */
export function flagsFrom(settings: ReadonlyMap<string, string>): Record<FeatureFlag, boolean> {
  const flags = { ...FLAG_DEFAULTS };
  for (const flag of FEATURE_FLAGS) {
    const stored = settings.get(flag);
    if (stored !== undefined) flags[flag] = stored === "true";
  }
  return flags;
}
