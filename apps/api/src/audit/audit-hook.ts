import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { parseSetCookieHeader } from "better-auth/cookies";
import { clientAddressOf } from "../core/client-address";
import { recordAudit, type AuditEntry } from "./audit-events";
import { auditEnabled } from "./audit-enabled";

// The method that auth.login and auth.signup record for Better Auth's sign-in
// endpoints. A sign-in through any other endpoint, such as one of a plugin the
// application adds, is recorded too, with the endpoint's path as its method. ctx.path is
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
// A new account records auth.signup from the plugin's database hook instead, so
// every endpoint that creates one is covered.
const ACTIONS: Readonly<Record<string, string>> = {
  "/sign-out": "auth.logout",
  "/change-password": "auth.password_change",
  "/change-email": "auth.email_change",
  "/email-otp/change-email": "auth.email_change",
  "/reset-password": "auth.password_reset",
  "/email-otp/reset-password": "auth.password_reset",
  "/phone-number/reset-password": "auth.password_reset",
  "/send-verification-email": "auth.verification_sent",
  "/verify-email": "auth.email_verified",
  "/email-otp/verify-email": "auth.email_verified",
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

interface AuditUser {
  id: string;
  name?: string | null;
  email?: string | null;
}

interface SessionRecord {
  session: { token: string; impersonatedBy?: string | null };
  user: AuditUser;
}

// What the plugin's database hooks saw one request do. Better Auth copies its
// context for every endpoint call and hands that copy, ctx.context, to the
// endpoint, to the database hooks the endpoint triggers, and to its own hooks,
// so the copy identifies the request.
interface Observed {
  /** The user /admin/create-user created. */
  created?: AuditUser;
  /** The user the request last updated, such as the one an email link verified. */
  updated?: AuditUser;
  /** The user whose password-reset link the request presented. */
  resetUserId?: string;
  /** The owners of the sessions the request ended, in order. */
  endedSessions: string[];
}

const observations = new WeakMap<object, Observed>();

function observe(context: object): Observed {
  let observed = observations.get(context);
  if (!observed) {
    observed = { endedSessions: [] };
    observations.set(context, observed);
  }
  return observed;
}

interface RequestShape {
  path?: string;
  params?: unknown;
  body?: unknown;
}

// How a request signed someone in or up: the name in SIGN_IN_METHODS, otherwise
// the endpoint's path, and the provider of a social sign-in.
function methodOf({ path = "", params, body }: RequestShape): Record<string, string> {
  const method = path === "/sign-up/email" ? "password" : (SIGN_IN_METHODS[path] ?? path);
  if (method !== "social") return { method };
  const provider = (params as { id?: string } | undefined)?.id ?? (body as { provider?: string } | undefined)?.provider;
  return provider ? { method, provider } : { method };
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

type DatabaseHooks = NonNullable<BetterAuthOptions["databaseHooks"]>;
type HookContext = Parameters<NonNullable<NonNullable<NonNullable<DatabaseHooks["user"]>["create"]>["after"]>>[1];

const who = (user: AuditUser | null | undefined): Pick<AuditEntry, "actorId" | "actorName" | "actorEmail"> => ({
  actorId: user?.id ?? null,
  actorName: user?.name ?? null,
  actorEmail: user?.email ?? null,
});

// Records auth and admin actions through the application audit pipeline. Pushed
// after every other plugin, because after hooks run in plugin order and earlier
// ones change the outcome: two-factor turns a password sign-in into a pending
// challenge by clearing ctx.context.newSession. It runs for every endpoint, the
// server-side session lookup of each API request included, so a request with
// neither an action nor a new session returns before any other work.
//
// Its database hooks see what a request did to users and sessions, so entries
// name the user even when the request carries no session: a new account is
// recorded when it is stored, whichever endpoint creates it and even when the
// request then fails (a social sign-up that waits for approval gets no
// session), and a sign-out names the owner of the session it ended.
export function auditPlugin(options: AuditPluginOptions = {}): BetterAuthPlugin & { id: "podokit-audit" } {
  const enabled = options.enabled ?? auditEnabled;

  async function recordSignUp(user: AuditUser, context: HookContext): Promise<void> {
    if (!(await enabled())) return;
    if (context?.path === "/admin/create-user") {
      // Recorded as user.create by the request's after hook.
      observe(context.context).created = user;
      return;
    }
    await recordAudit({
      action: "auth.signup",
      ...(context ? who(user) : {}),
      targetId: user.id,
      targetLabel: user.email ?? null,
      ip: clientAddressOf(context?.headers) ?? null,
      ...(context ? { metadata: methodOf(context) } : {}),
    });
  }

  const databaseHooks: DatabaseHooks = {
    user: {
      create: { after: async (user, context) => recordSignUp(user, context) },
      update: {
        after: async (user, context) => {
          if (context) observe(context.context).updated = user;
        },
      },
    },
    session: {
      delete: {
        // deleteWithHooks reads the row before it deletes it, so this costs no query.
        before: async (session, context) => {
          if (context) observe(context.context).endedSessions.push(session.userId);
        },
      },
    },
  };

  return {
    id: "podokit-audit",
    init: () => ({ options: { databaseHooks } }),
    hooks: {
      before: [
        {
          // The endpoint consumes the link's token, so find its user first.
          matcher: (context) => context.path === "/reset-password",
          handler: createAuthMiddleware(async (ctx) => {
            const token =
              (ctx.body as { token?: string } | undefined)?.token ?? (ctx.query as { token?: string } | undefined)?.token;
            if (!token || !(await enabled())) return;
            try {
              const verification = await ctx.context.internalAdapter.findVerificationValue(`reset-password:${token}`);
              if (verification?.value) observe(ctx.context).resetUserId = verification.value;
            } catch {
              // The entry then names no account; the reset itself goes ahead.
            }
          }),
        },
      ],
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
            const seen = observations.get(ctx.context);
            // A failed lookup leaves the entry without that user; it never fails the request.
            const quietly = async (find: () => Promise<AuditUser | null | undefined>): Promise<AuditUser | null> => {
              try {
                return (await find()) ?? null;
              } catch {
                return null;
              }
            };
            const userById = async (id: string | null | undefined): Promise<AuditUser | null> =>
              id ? quietly(() => ctx.context.internalAdapter.findUserById(id)) : null;

            if (action === "auth.logout") {
              // One entry per account whose session ended: multiSession() signs
              // out every account of the browser. A sign-out without a session
              // ends none and records nothing.
              for (const id of new Set(seen?.endedSessions)) {
                const user = (await userById(id)) ?? { id };
                await recordAudit({ action, ...who(user), targetId: id, targetLabel: user.email ?? null, ip });
              }
            } else if (action) {
              const session = ctx.context.session;
              const body = (ctx.body ?? {}) as { email?: string; userId?: string; phoneNumber?: string };
              let actor: AuditUser | null = session?.user ?? ctx.context.newSession?.user ?? null;
              // The user the request acted on when its body does not name one.
              let subject: AuditUser | null = null;
              if (action === "user.create") subject = seen?.created ?? null;
              else if (action === "user.session_revoke") subject = await userById(seen?.endedSessions[0]);
              else if (action === "user.stop_impersonate" && session?.session.impersonatedBy) {
                // The session is the impersonated user's; the administrator ends it.
                subject = session.user;
                actor = (await userById(session.session.impersonatedBy)) ?? actor;
              } else if (action === "auth.email_verified") {
                subject = seen?.updated ?? null;
                actor ??= subject;
              } else if (action === "auth.password_reset") {
                // Whoever holds the link or code acts as the account's owner.
                if (ctx.path === "/reset-password") subject = await userById(seen?.resetUserId);
                else if (ctx.path === "/email-otp/reset-password" && body.email) {
                  const email = body.email;
                  subject = await quietly(async () => (await ctx.context.internalAdapter.findUserByEmail(email))?.user);
                } else if (ctx.path === "/phone-number/reset-password" && body.phoneNumber) {
                  const phoneNumber = body.phoneNumber;
                  subject = await quietly(() =>
                    ctx.context.adapter.findOne<AuditUser>({ model: "user", where: [{ field: "phoneNumber", value: phoneNumber }] }),
                  );
                }
                actor ??= subject;
              }

              // Prefer a human-readable target: the email in the body, otherwise
              // the target user's email by id (the id for already-deleted users).
              const targetId = body.userId ?? subject?.id ?? null;
              let targetLabel = body.email ?? subject?.email ?? body.phoneNumber ?? null;
              if (!targetLabel && targetId) targetLabel = (await userById(targetId))?.email ?? targetId;
              await recordAudit({ action, ...who(actor), targetId, targetLabel, ip });
            }

            if (!login) return;
            await recordAudit({
              action: "auth.login",
              ...who(login.user),
              targetId: login.user.id,
              targetLabel: login.user.email ?? null,
              ip,
              metadata: methodOf(ctx),
            });
          }),
        },
      ],
    },
  };
}
