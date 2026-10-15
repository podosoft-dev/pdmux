import { APIError, createAuthMiddleware } from "better-auth/api";
import { FLAG_DEFAULTS, type FeatureFlag } from "../settings/flag-defaults";

export const PUBLIC_SIGNUP_DISABLED = "PUBLIC_SIGNUP_DISABLED" as const;

/** Auth-relative path prefixes owned by each admin-toggleable feature. A path is
 *  gated when it equals a prefix or starts with a prefix ending in "/". */
const FEATURE_PATHS: Array<{ flag: FeatureFlag; prefixes: string[] }> = [
  { flag: "twoFactor", prefixes: ["/two-factor/"] },
  { flag: "magicLink", prefixes: ["/sign-in/magic-link", "/magic-link/"] },
  { flag: "emailOtp", prefixes: ["/email-otp/", "/sign-in/email-otp"] },
  { flag: "username", prefixes: ["/sign-in/username"] },
  { flag: "multiSession", prefixes: ["/multi-session/"] },
  { flag: "phoneNumber", prefixes: ["/phone-number/", "/sign-in/phone-number"] },
  { flag: "apiKey", prefixes: ["/api-key/"] },
  { flag: "passkey", prefixes: ["/passkey/", "/sign-in/passkey"] },
  { flag: "organization", prefixes: ["/organization"] },
  { flag: "oidcProvider", prefixes: ["/oauth2/", "/.well-known/openid-configuration", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"] },
];

export type FeatureFlags = Record<FeatureFlag, boolean>;

/** Live settings the gate reads per request, normally the shared settings snapshot. */
export interface FeatureGateSettings {
  flags: () => Promise<FeatureFlags>;
  signupOpen: () => Promise<boolean>;
}

/** Public registration is the default until an administrator explicitly closes it. */
export function signupOpenFrom(settings: ReadonlyMap<string, string>): boolean {
  return settings.get("site.allowSignup") !== "false";
}

/** A settings read failure keeps public sign-up open. */
export async function readSignupOpen(signupOpen: () => Promise<boolean>): Promise<boolean> {
  try {
    return await signupOpen();
  } catch {
    return true;
  }
}

/** A settings read failure applies the shipped defaults. */
export async function readFeatureFlags(flags: () => Promise<FeatureFlags>): Promise<FeatureFlags> {
  try {
    return await flags();
  } catch {
    return { ...FLAG_DEFAULTS };
  }
}

/** Administrator-created users are intentional and remain available when the
 *  public site is invite-only. Every other new-user path, including OAuth
 *  callbacks, must follow the public registration setting. */
export function isUserCreationAllowed(signupOpen: boolean, requestPath?: string): boolean {
  return signupOpen || requestPath === "/admin/create-user";
}

export function assertUserCreationAllowed(signupOpen: boolean, requestPath?: string): void {
  if (isUserCreationAllowed(signupOpen, requestPath)) return;
  throw APIError.from("FORBIDDEN", {
    code: PUBLIC_SIGNUP_DISABLED,
    message: "Public sign-up is disabled.",
  });
}

/** Server-side enforcement for the admin Settings toggles: requests to a disabled
 *  feature's endpoints are rejected with 404, so "off" is a real boundary rather
 *  than hidden UI. Throws the API error for a rejected path. */
export async function enforceFeatureGate(path: string, settings: FeatureGateSettings): Promise<void> {
  // Reject explicit sign-up endpoints early. OAuth starts remain available so
  // existing social users can sign in; their new-user callback is enforced by
  // the database hook that uses this same policy.
  if (path === "/sign-up/email" || path.startsWith("/sign-up/")) {
    assertUserCreationAllowed(await readSignupOpen(settings.signupOpen), path);
    return;
  }
  const feature = FEATURE_PATHS.find((f) =>
    f.prefixes.some((p) => path === p || path.startsWith(p)),
  );
  if (!feature) return;
  const enabled = (await readFeatureFlags(settings.flags))[feature.flag];
  if (!enabled) throw new APIError("NOT_FOUND", { message: "This feature is disabled." });
}

/** Better Auth middleware over {@link enforceFeatureGate}. The settings come from
 *  the shared snapshot (a toggle takes effect within its TTL); before the
 *  migration has run, the shipped defaults apply. */
export function createFeatureGate(settings: FeatureGateSettings): ReturnType<typeof createAuthMiddleware> {
  return createAuthMiddleware(async (ctx) => {
    await enforceFeatureGate(ctx.path, settings);
  });
}
