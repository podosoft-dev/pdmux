import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { parseSetCookieHeader } from "better-auth/cookies";
import { clientAddressOf } from "../core/client-address";
import { recordAudit } from "./audit-events";
import { auditEnabled } from "./audit-enabled";

// The method that auth.login records for Better Auth's sign-in endpoints. A
// sign-in through any other endpoint, such as one of a plugin the application
// adds, is recorded too, with the endpoint's path as its method. ctx.path is
// the route pattern an endpoint was registered with, not the request URL, so
// every social provider's callback arrives as "/callback/:id".
export const SIGN_IN_METHODS: Readonly<Record<string, string>> = {
  "/sign-in/email": "password",
  "/sign-in/username": "username",
  "/sign-in/phone-number": "phone-number",
  "/sign-in/email-otp": "email-otp",
  "/sign-in/social": "social",
  "/callback/:id": "social",
  "/magic-link/verify": "magic-link",
  "/passkey/verify-authentication": "passkey",
  "/phone-number/verify": "phone-number-otp",
  "/two-factor/verify-totp": "two-factor-totp",
  "/two-factor/verify-otp": "two-factor-otp",
  "/two-factor/verify-backup-code": "two-factor-backup-code",
  "/verify-email": "email-verification",
  "/email-otp/verify-email": "email-otp-verification",
};

// Endpoints that can end with a session the request did not come with without
// signing anyone in: a sign-up, recorded as auth.signup; an administrator
// starting or ending an impersonation; a switch to another session the browser
// already holds; and requests that replace the signed-in user's own session.
export const NOT_SIGN_INS: ReadonlySet<string> = new Set([
  "/sign-up/email",
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
  "/multi-session/set-active",
  "/multi-session/revoke",
  "/two-factor/enable",
  "/two-factor/disable",
  "/change-password",
]);

// Other auth and admin endpoints, with the action each records once it succeeds.
const ACTIONS: Readonly<Record<string, string>> = {
  "/sign-up/email": "auth.signup",
  "/sign-out": "auth.logout",
  "/change-password": "auth.password_change",
  "/change-email": "auth.email_change",
  "/reset-password": "auth.password_reset",
  "/send-verification-email": "auth.verification_sent",
  "/verify-email": "auth.email_verified",
  "/update-user": "account.update",
  "/delete-user": "account.delete",
  "/revoke-session": "session.revoke",
  "/revoke-sessions": "session.revoke_all",
  "/revoke-other-sessions": "session.revoke_others",
  "/two-factor/enable": "2fa.enable",
  "/two-factor/disable": "2fa.disable",
  "/admin/create-user": "user.create",
  "/admin/update-user": "user.update",
  "/admin/remove-user": "user.delete",
  "/admin/set-role": "user.role_change",
  "/admin/set-user-password": "user.password_set",
  "/admin/ban-user": "user.ban",
  "/admin/unban-user": "user.unban",
  "/admin/revoke-user-session": "user.session_revoke",
  "/admin/revoke-user-sessions": "user.session_revoke_all",
  "/admin/impersonate-user": "user.impersonate",
  "/admin/stop-impersonating": "user.stop_impersonate",
};

interface SessionRecord {
  session: { token: string };
  user: { id: string; name?: string | null; email?: string | null };
}

interface SignInContext {
  path: string;
  context: {
    session: SessionRecord | null;
    responseHeaders?: Headers;
    secret: string;
    authCookies: { sessionToken: { name: string } };
    internalAdapter: { findSession: (token: string) => Promise<unknown> };
  };
  getSignedCookie: (name: string, secret: string) => Promise<string | null | false>;
}

// After hooks run for failed requests too, with the APIError the endpoint threw
// in ctx.context.returned. Redirects are APIErrors as well: a 3xx status, and an
// `error` query parameter on the location when the redirect reports a failure.
function failed(returned: unknown): boolean {
  if (!isAPIError(returned)) return false;
  if (returned.statusCode >= 400) return true;
  const location = new Headers(returned.headers).get("location");
  if (!location) return false;
  try {
    return new URL(location, "http://localhost").searchParams.has("error");
  } catch {
    return false;
  }
}

// A sign-in ends with a session the request did not come with, on any endpoint
// but those in NOT_SIGN_INS.
// - Its response sets the session cookie to the new session. An endpoint that
//   another one dispatches, as oauthProvider() runs /oauth2/authorize when a
//   sign-in resumes an authorization request, inherits that request's new
//   session without setting it.
// - A request that refreshes its own session, such as a session read that
//   extends it or a profile update, sets it again: the session cookie it sent,
//   or the one bearer() made of its Authorization header, has the same token.
// - Confirming two-factor replaces the signed-in user's session, which the
//   endpoint loaded into ctx.context.session.
// - When the session the endpoint loaded is the new one, a stored session is a
//   sign-in: oauthProvider() loads it when a sign-in resumes an authorization
//   request. The session of an API key request (apiKey's
//   enableSessionForAPIKeys) has the key as its token and is not stored.
async function signedIn(ctx: SignInContext, created: SessionRecord): Promise<boolean> {
  if (NOT_SIGN_INS.has(ctx.path)) return false;
  const { token } = created.session;
  const set = parseSetCookieHeader(ctx.context.responseHeaders?.get("set-cookie") ?? "");
  const cookie = set.get(ctx.context.authCookies.sessionToken.name)?.value;
  if (decodeURIComponent(cookie ?? "").split(".")[0] !== token) return false;
  const presented = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
  if (token === presented) return false;
  const current = ctx.context.session;
  if (!current) return true;
  if (current.session.token !== token) return current.user.id !== created.user.id;
  return Boolean(await ctx.context.internalAdapter.findSession(token));
}

export interface AuditPluginOptions {
  /** Whether auditing is on. Defaults to the admin Settings toggle. */
  enabled?: () => Promise<boolean>;
}

// Records auth and admin actions through the application audit pipeline. Pushed
// after every other plugin, because after hooks run in plugin order and earlier
// ones change the outcome: two-factor turns a password sign-in into a pending
// challenge by clearing ctx.context.newSession. It runs for every endpoint, the
// server-side session lookup of each API request included, so a request with
// neither an action nor a new session returns before any other work.
export function auditPlugin(options: AuditPluginOptions = {}): BetterAuthPlugin & { id: "podokit-audit" } {
  const enabled = options.enabled ?? auditEnabled;
  return {
    id: "podokit-audit",
    hooks: {
      after: [
        {
          matcher: (context) => Boolean(context.path),
          handler: createAuthMiddleware(async (ctx) => {
            const action = ACTIONS[ctx.path];
            const created = ctx.context.newSession;
            if (!action && !created) return;
            if (failed(ctx.context.returned)) return;
            const login = created && (await signedIn(ctx, created)) ? created : null;
            if (!action && !login) return;
            // AuditService checks the toggle again on write; checking here as well
            // skips the lookups below when auditing is off.
            if (!(await enabled())) return;
            const ip = clientAddressOf(ctx.headers) ?? null;

            if (action) {
              const actor = ctx.context.session?.user ?? ctx.context.newSession?.user;
              const body = (ctx.body ?? {}) as { email?: string; userId?: string };

              // Prefer a human-readable target: the email in the body, otherwise
              // the target user's email by id (the id for already-deleted users).
              const targetId = body.userId ?? null;
              let targetLabel = body.email ?? null;
              if (!targetLabel && targetId) {
                try {
                  const target = await ctx.context.internalAdapter.findUserById(targetId);
                  targetLabel = target?.email ?? targetId;
                } catch {
                  targetLabel = targetId;
                }
              }
              await recordAudit({
                action,
                actorId: actor?.id ?? null,
                actorName: actor?.name ?? null,
                actorEmail: actor?.email ?? null,
                targetId,
                targetLabel,
                ip,
              });
            }

            if (!login) return;
            const method = SIGN_IN_METHODS[ctx.path] ?? ctx.path;
            const params = (ctx.params ?? {}) as { id?: string };
            const body = (ctx.body ?? {}) as { provider?: string };
            const provider = method === "social" ? (params.id ?? body.provider) : undefined;
            await recordAudit({
              action: "auth.login",
              actorId: login.user.id,
              actorName: login.user.name ?? null,
              actorEmail: login.user.email ?? null,
              targetId: login.user.id,
              targetLabel: login.user.email ?? null,
              ip,
              metadata: provider ? { method, provider } : { method },
            });
          }),
        },
      ],
    },
  };
}
