/** Admin-managed auth feature flags and their shipped defaults.
 *
 *  Kept free of Nest/TypeORM imports so both the DI-managed SettingsService and
 *  the better-auth feature gate (loaded by auth.ts, outside DI — including when
 *  the better-auth CLI evaluates auth.ts for migrations) can import it safely.
 *
 *  Must match the rows seeded by the InitAppSettings migration. phoneNumber is
 *  off by default because real delivery needs an SMS provider. */
export type FeatureFlag = "twoFactor" | "magicLink" | "emailOtp" | "username" | "multiSession" | "phoneNumber" | "apiKey" | "passkey" | "organization" | "oidcProvider" | "require2fa";

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
  // two-factor before using the app. Enforced by TwoFactorRequiredGuard + the web
  // enrolment gate — the feature gate ignores it (no endpoint prefix). Off by default.
  require2fa: false,
};

export const FEATURE_FLAGS = Object.keys(FLAG_DEFAULTS) as FeatureFlag[];
