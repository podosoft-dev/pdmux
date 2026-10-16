import { Elysia, t } from "elysia";
import type { AuthService } from "../auth/auth.service";
import type { ElysiaPlugin } from "../core/services";
import {
  ADMIN_USER_SORT_FIELDS,
  ADMIN_USER_STATUSES,
  ADMIN_USERS_MAX_LIMIT,
  type AdminUsersService,
} from "./admin-users.service";

export interface AdminUserRoutesOptions {
  auth: Pick<AuthService, "requireAdmin">;
  users: AdminUsersService;
}

export function adminUserRoutes({ auth, users }: AdminUserRoutesOptions): ElysiaPlugin {
  return new Elysia({ name: "podokit.admin.users" })
    .get("/admin/users", async ({ request, query }) => {
      await auth.requireAdmin(request);
      return users.list(query);
    }, {
      query: t.Object({
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: ADMIN_USERS_MAX_LIMIT })),
        offset: t.Optional(t.Numeric({ minimum: 0 })),
        search: t.Optional(t.String({ maxLength: 200 })),
        searchField: t.Optional(t.Union([t.Literal("email"), t.Literal("name")])),
        role: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
        status: t.Optional(t.Union(ADMIN_USER_STATUSES.map((status) => t.Literal(status)))),
        sortBy: t.Optional(t.Union(ADMIN_USER_SORT_FIELDS.map((field) => t.Literal(field)))),
        sortDirection: t.Optional(t.Union([t.Literal("asc"), t.Literal("desc")])),
      }),
      detail: {
        tags: ["admin"],
        summary: "List users",
        description:
          "Administrators only. Offset-paged with `limit` and `offset`; newest first unless " +
          "`sortBy`/`sortDirection` say otherwise. `search` matches `searchField` (email by " +
          "default) case-insensitively. `role` and `status` (active, pending, banned) combine.",
      },
    });
}
