import { AppException } from "@podosoft/podokit-contracts";
import { Elysia, t } from "elysia";
import type { AuthService, AuthSession } from "../auth/auth.service";
import type { ElysiaPlugin } from "../core/services";
import {
  ADMIN_SESSIONS_MAX_LIMIT,
  type AdminSessionsService,
  type AdminSessionView,
} from "../admin-sessions/admin-sessions.service";

export const ACCOUNT_SESSION_NOT_FOUND = "ACCOUNT_SESSION_NOT_FOUND";
/** Better Auth's code for a session older than `session.freshAge`. */
export const SESSION_NOT_FRESH = "SESSION_NOT_FRESH";

/** One of the caller's own sessions. The bearer token never leaves the server. */
export interface AccountSessionView {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface AccountSessionPage {
  /** The session making the request, on every page. */
  current: AccountSessionView | null;
  /** The caller's other active sessions, newest first. */
  items: AccountSessionView[];
  nextCursor: string | null;
  /** Every active session of the caller, the current one included. */
  total: number;
}

/** Revokes one of the caller's sessions by its bearer token. */
export type OwnSessionRevoker = (sessionToken: string, headers: Headers) => Promise<void>;

export interface AccountSessionRoutesOptions {
  auth: Pick<AuthService, "requireSession">;
  sessions: AdminSessionsService;
  revoke: OwnSessionRevoker;
  /** Better Auth's `session.freshAge` in seconds; 0 turns the check off. */
  freshAgeSeconds: () => Promise<number>;
}

function accountView(session: AdminSessionView): AccountSessionView {
  return {
    id: session.id,
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}

// Better Auth lists sessions only for a fresh session; this list keeps that rule.
function requireFresh(session: AuthSession, freshAgeSeconds: number): void {
  if (freshAgeSeconds === 0) return;
  const createdAt = new Date(session.session.createdAt as string | Date).getTime();
  if (Date.now() - createdAt >= freshAgeSeconds * 1000) {
    throw new AppException(SESSION_NOT_FRESH, "Session is not fresh", 403);
  }
}

/**
 * The signed-in user's own sessions, paged on the server. Better Auth's
 * `/list-sessions` returns at most 100 sessions, which could leave out the
 * current one.
 */
export function accountSessionRoutes({
  auth,
  sessions,
  revoke,
  freshAgeSeconds,
}: AccountSessionRoutesOptions): ElysiaPlugin {
  return new Elysia({ name: "podokit.account.sessions" })
    .get("/account/sessions", async ({ request, query }) => {
      const session = await auth.requireSession(request);
      requireFresh(session, await freshAgeSeconds());
      const currentId = String(session.session.id);
      const [page, current] = await Promise.all([
        sessions.list({ ...query, userId: session.user.id, excludeId: currentId }),
        sessions.find(currentId),
      ]);
      const result: AccountSessionPage = {
        current: current ? accountView(current) : null,
        items: page.items.map(accountView),
        nextCursor: page.nextCursor,
        total: page.total + (current ? 1 : 0),
      };
      return result;
    }, {
      query: t.Object({
        cursor: t.Optional(t.String({ minLength: 1, maxLength: 512 })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: ADMIN_SESSIONS_MAX_LIMIT })),
      }),
      detail: {
        tags: ["account"],
        summary: "List the current user's active sessions",
        description: "`current` is the session making the request; `items` are the other sessions, newest first, keyset-paged with `cursor`. Session tokens are never returned. A session older than Better Auth's `session.freshAge` gets 403 `SESSION_NOT_FRESH`, as with `/api/auth/list-sessions`.",
      },
    })
    .delete("/account/sessions/:id", async ({ request, params, set }) => {
      const session = await auth.requireSession(request);
      const token = await sessions.tokenOf(params.id, session.user.id);
      if (!token) throw new AppException(ACCOUNT_SESSION_NOT_FOUND, "Session not found.", 404);
      await revoke(token, request.headers);
      set.status = 204;
    }, {
      params: t.Object({ id: t.String({ minLength: 1, maxLength: 255 }) }),
      detail: { tags: ["account"], summary: "Revoke one of the current user's sessions by id" },
    });
}
