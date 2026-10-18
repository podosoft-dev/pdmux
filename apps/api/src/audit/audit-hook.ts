import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { clientAddressOf } from "../core/client-address";
import { recordAudit } from "./audit-events";
import { auditEnabled } from "./audit-enabled";

// Endpoints that sign a user in, with the method their auth.login entry records.
// ctx.path is the route pattern an endpoint was registered with, not the request
// URL, so every social provider's callback arrives as "/callback/:id".
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

// A sign-in ends with a session the request did not come with. Two requests end
// with a new session without signing anyone in: confirming two-factor replaces
// the signed-in user's session, which two-factor loaded into ctx.context.session,
// and verifying the signed-in user's email sets the cookie of the session the
// request came with again. oauthProvider() also puts the new session into
// ctx.context.session when a sign-in resumes an authorization request.
function signedIn(
  created: SessionRecord | null | undefined,
  current: SessionRecord | null | undefined,
  presentedToken: string | null | false,
): created is SessionRecord {
  if (!created || created.session.token === presentedToken) return false;
  return !(current && current.user.id === created.user.id && current.session.token !== created.session.token);
}

export interface AuditPluginOptions {
  /** Whether auditing is on. Defaults to the admin Settings toggle. */
  enabled?: () => Promise<boolean>;
}

// Records auth and admin actions through the application audit pipeline. Pushed
// after every other plugin, because after hooks run in plugin order and earlier
// ones change the outcome: two-factor turns a password sign-in into a pending
// challenge by clearing ctx.context.newSession.
export function auditPlugin(options: AuditPluginOptions = {}): BetterAuthPlugin & { id: "podokit-audit" } {
  const enabled = options.enabled ?? auditEnabled;
  return {
    id: "podokit-audit",
    hooks: {
      after: [
        {
          matcher: (context) => Boolean(context.path && (SIGN_IN_METHODS[context.path] || ACTIONS[context.path])),
          handler: createAuthMiddleware(async (ctx) => {
            if (failed(ctx.context.returned)) return;
            // AuditService checks the toggle again on write; checking here as well
            // skips the lookups below when auditing is off.
            if (!(await enabled())) return;
            const ip = clientAddressOf(ctx.headers) ?? null;

            const action = ACTIONS[ctx.path];
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

            const method = SIGN_IN_METHODS[ctx.path];
            if (!method) return;
            const created = ctx.context.newSession;
            const presented = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
            if (!signedIn(created, ctx.context.session, presented)) return;
            const params = (ctx.params ?? {}) as { id?: string };
            const body = (ctx.body ?? {}) as { provider?: string };
            const provider = method === "social" ? (params.id ?? body.provider) : undefined;
            await recordAudit({
              action: "auth.login",
              actorId: created.user.id,
              actorName: created.user.name ?? null,
              actorEmail: created.user.email ?? null,
              targetId: created.user.id,
              targetLabel: created.user.email ?? null,
              ip,
              metadata: provider ? { method, provider } : { method },
            });
          }),
        },
      ],
    },
  };
}
