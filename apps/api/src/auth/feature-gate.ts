import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { FLAG_DEFAULTS, type FeatureFlag } from "../settings/flag-defaults";

export const PUBLIC_SIGNUP_DISABLED = "PUBLIC_SIGNUP_DISABLED" as const;

/** Auth-relative path prefixes owned by each admin-toggleable feature. A path is
 *  gated when it starts with one of its feature's prefixes. The OIDC provider's
 *  JWKS (`/jwks`) and session JWT (`/token`) belong to the always-on `jwt`
 *  plugin, so they stay available while the provider is off. */
const FEATURE_PATHS: Array<{ flag: FeatureFlag; prefixes: string[] }> = [
  { flag: "twoFactor", prefixes: ["/two-factor/"] },
  { flag: "magicLink", prefixes: ["/sign-in/magic-link", "/magic-link/"] },
  { flag: "emailOtp", prefixes: ["/email-otp/", "/sign-in/email-otp"] },
  { flag: "username", prefixes: ["/sign-in/username"] },
  { flag: "multiSession", prefixes: ["/multi-session/"] },
  { flag: "phoneNumber", prefixes: ["/phone-number/", "/sign-in/phone-number"] },
  { flag: "apiKey", prefixes: ["/api-key/"] },
  { flag: "passkey", prefixes: ["/passkey/", "/sign-in/passkey"] },
  {
    flag: "teams",
    prefixes: [
      "/organization/create-team",
      "/organization/update-team",
      "/organization/remove-team",
      "/organization/list-team",
      "/organization/list-user-teams",
      "/organization/set-active-team",
      "/organization/add-team-member",
    ],
  },
  { flag: "organization", prefixes: ["/organization"] },
  {
    flag: "oidcProvider",
    prefixes: [
      "/oauth2/",
      "/admin/oauth2/",
      "/.well-known/openid-configuration",
      // Also matches the RFC 8414 form outside the base path,
      // /.well-known/oauth-authorization-server/api/auth.
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
    ],
  },
];

/** Every admin-toggleable feature an auth-relative path belongs to, most
 *  specific first. A team endpoint belongs to both teams and organization, so it
 *  is open only while both are on. */
export function featuresForPath(path: string): FeatureFlag[] {
  return FEATURE_PATHS.filter((f) => f.prefixes.some((p) => path.startsWith(p))).map((f) => f.flag);
}

/** The most specific admin-toggleable feature that owns an auth-relative path, if any. */
export function featureForPath(path: string): FeatureFlag | undefined {
  return featuresForPath(path)[0];
}

/** Whether a path belongs to a feature that is switched off. */
function pathDisabled(path: string, flags: FeatureFlags): boolean {
  return featuresForPath(path).some((flag) => !flags[flag]);
}

/** A request's path relative to Better Auth's base URL. A path outside the base
 *  path is returned whole. */
export function authRequestPath(requestUrl: string, baseURL: string): string {
  const pathname = new URL(requestUrl).pathname;
  const basePath = new URL(baseURL).pathname.replace(/\/+$/, "");
  return basePath && pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
}

function featureDisabled(): APIError {
  return new APIError("NOT_FOUND", { message: "This feature is disabled." });
}

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
  if (featuresForPath(path).length === 0) return;
  if (pathDisabled(path, await readFeatureFlags(settings.flags))) throw featureDisabled();
}

/** Better Auth middleware over {@link enforceFeatureGate}. The settings come from
 *  the shared snapshot (a toggle takes effect within its TTL); before the
 *  migration has run, the shipped defaults apply. */
export function createFeatureGate(settings: FeatureGateSettings): ReturnType<typeof createAuthMiddleware> {
  return createAuthMiddleware(async (ctx) => {
    await enforceFeatureGate(ctx.path, settings);
  });
}

/** Rejects HTTP requests to a disabled feature before any plugin's `onRequest`
 *  runs. `hooks.before` alone is not enough: the OAuth provider answers its
 *  discovery metadata from `onRequest`, which Better Auth runs before endpoint
 *  hooks. Register this plugin ahead of every other plugin. */
export function featureGatePlugin(settings: FeatureGateSettings): BetterAuthPlugin {
  return {
    id: "podokit-feature-gate",
    onRequest: async (request, ctx) => {
      const path = authRequestPath(request.url, ctx.baseURL);
      if (featuresForPath(path).length === 0) return undefined;
      if (!pathDisabled(path, await readFeatureFlags(settings.flags))) return undefined;
      const error = featureDisabled();
      return { response: Response.json(error.body, { status: error.statusCode }) };
    },
  };
}
