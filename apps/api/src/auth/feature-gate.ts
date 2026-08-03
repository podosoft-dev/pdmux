import { APIError, createAuthMiddleware } from "better-auth/api";
import type { Pool } from "pg";
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

const CACHE_TTL_MS = 3_000;

export type SignupOpenCheck = () => Promise<boolean>;

/** Public registration is the default until an administrator explicitly closes
 *  it. The short cache keeps every auth flow on the same live site-setting
 *  policy without rebuilding the Better Auth instance. */
export function createSignupOpenCheck(pool: Pool): SignupOpenCheck {
  let signupOpen = true;
  let fetchedAt = 0;

  return async (): Promise<boolean> => {
    if (Date.now() - fetchedAt < CACHE_TTL_MS) return signupOpen;
    try {
      const res = await pool.query<{ value: string }>(
        'SELECT "value" FROM "app_setting" WHERE "key" = $1',
        ["site.allowSignup"],
      );
      signupOpen = res.rows[0]?.value !== "false";
    } catch {
      signupOpen = true;
    }
    fetchedAt = Date.now();
    return signupOpen;
  };
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
 *  than hidden UI. Flags are read from app_setting through a small TTL cache
 *  (a toggle takes effect within ~CACHE_TTL_MS); before the migration has run,
 *  the shipped defaults apply. */
export function createFeatureGate(
  pool: Pool,
  isSignupOpen: SignupOpenCheck = createSignupOpenCheck(pool),
) {
  let cache: Record<FeatureFlag, boolean> = { ...FLAG_DEFAULTS };
  let fetchedAt = 0;

  async function flags(): Promise<Record<FeatureFlag, boolean>> {
    if (Date.now() - fetchedAt < CACHE_TTL_MS) return cache;
    try {
      const res = await pool.query<{ key: string; value: string }>(
        'SELECT "key", "value" FROM "app_setting" WHERE "key" = ANY($1)',
        [Object.keys(FLAG_DEFAULTS)],
      );
      const next = { ...FLAG_DEFAULTS };
      for (const row of res.rows) next[row.key as FeatureFlag] = row.value === "true";
      cache = next;
    } catch {
      cache = { ...FLAG_DEFAULTS };
    }
    fetchedAt = Date.now();
    return cache;
  }

  return createAuthMiddleware(async (ctx) => {
    // Reject explicit sign-up endpoints early. OAuth starts remain available so
    // existing social users can sign in; their new-user callback is enforced by
    // the database hook that uses this same policy.
    if (ctx.path === "/sign-up/email" || ctx.path.startsWith("/sign-up/")) {
      assertUserCreationAllowed(await isSignupOpen(), ctx.path);
      return;
    }
    const feature = FEATURE_PATHS.find((f) =>
      f.prefixes.some((p) => ctx.path === p || ctx.path.startsWith(p)),
    );
    if (!feature) return;
    const enabled = (await flags())[feature.flag];
    if (!enabled) throw new APIError("NOT_FOUND", { message: "This feature is disabled." });
  });
}
