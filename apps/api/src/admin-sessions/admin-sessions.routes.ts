import { AppException } from "@podosoft/podokit-contracts";
import { Elysia, t } from "elysia";
import type { AuthService } from "../auth/auth.service";
import type { ElysiaPlugin } from "../core/services";
import { ADMIN_SESSIONS_MAX_LIMIT, type AdminSessionsService } from "./admin-sessions.service";

export const ADMIN_SESSION_NOT_FOUND = "ADMIN_SESSION_NOT_FOUND";

/** Revokes one session by its bearer token on behalf of the requesting administrator. */
export type SessionRevoker = (sessionToken: string, headers: Headers) => Promise<void>;

export interface AdminSessionRoutesOptions {
  auth: Pick<AuthService, "requireAdmin">;
  sessions: AdminSessionsService;
  revoke: SessionRevoker;
}

export function adminSessionRoutes({ auth, sessions, revoke }: AdminSessionRoutesOptions): ElysiaPlugin {
  return new Elysia({ name: "podokit.admin.sessions" })
    .get("/admin/sessions", async ({ request, query }) => {
      await auth.requireAdmin(request);
      return sessions.list(query);
    }, {
      query: t.Object({
        cursor: t.Optional(t.String({ minLength: 1, maxLength: 512 })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: ADMIN_SESSIONS_MAX_LIMIT })),
        search: t.Optional(t.String({ maxLength: 200 })),
        userId: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
      }),
      detail: {
        tags: ["admin"],
        summary: "List active sessions across users",
        description: "Newest first, keyset-paged with `cursor`. `search` matches the user's email or name case-insensitively. Session tokens are never returned.",
      },
    })
    .delete("/admin/sessions/:id", async ({ request, params, set }) => {
      await auth.requireAdmin(request);
      const token = await sessions.tokenOf(params.id);
      if (!token) throw new AppException(ADMIN_SESSION_NOT_FOUND, "Session not found.", 404);
      await revoke(token, request.headers);
      set.status = 204;
    }, {
      params: t.Object({ id: t.String({ minLength: 1, maxLength: 255 }) }),
      detail: { tags: ["admin"], summary: "Revoke a session by id" },
    });
}
