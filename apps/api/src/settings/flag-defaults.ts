/** Admin-managed auth feature flags and their shipped defaults.
 *
 *  Kept free of framework/ORM imports so both SettingsService and the Better
 *  Auth feature gate (loaded by auth.ts, including when
 *  the better-auth CLI evaluates auth.ts for migrations) can import it safely.
 *
 *  Must match the rows seeded by the InitAppSettings migration. phoneNumber is
 *  off by default because real delivery needs an SMS provider. */
export type FeatureFlag = "twoFactor" | "magicLink" | "emailOtp" | "username" | "multiSession" | "phoneNumber" | "apiKey" | "passkey" | "organization" | "oidcProvider" | "require2fa" | "mcpEnabled";

export const FLAG_DEFAULTS: Record<FeatureFlag, boolean> = {
  twoFactor: true,
  magicLink: true,
  emailOtp: true,
  username: true,
  multiSession: true,
  phoneNumber: false,
  apiKey: true,
  passkey: true,
  organization: true,
  // Acting as an OIDC identity provider is an enterprise opt-in; off by default.
  oidcProvider: false,
  // Policy (not a feature endpoint): when on, every signed-in user must enrol in
  // two-factor before using the app. Enforced by AuthService + the web
  // enrolment gate — the feature gate ignores it (no endpoint prefix). Off by default.
  require2fa: false,
  // Product policy rather than an authentication feature. It remains in the same
  // store so administrators can update it through the existing settings endpoint.
  mcpEnabled: true,
};

export const FEATURE_FLAGS = Object.keys(FLAG_DEFAULTS) as FeatureFlag[];
