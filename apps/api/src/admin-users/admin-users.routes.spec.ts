import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { AppException } from "@podosoft/podokit-contracts";
import { Elysia } from "elysia";
import type { AuthService, AuthSession } from "../auth/auth.service";
import { adminUserRoutes } from "./admin-users.routes";
import { AdminUsersService } from "./admin-users.service";

// Callers identify themselves with a test header; only "admin" passes.
const auth: Pick<AuthService, "requireAdmin"> = {
  requireAdmin: async (request: Request): Promise<AuthSession> => {
    const role = request.headers.get("x-test-role");
    if (!role) throw new AppException("AUTH_REQUIRED", "Authentication is required", 401);
    if (role !== "admin") throw new AppException("ADMIN_REQUIRED", "Administrator access is required", 403);
    return { user: { id: "admin-1", role: "admin" }, session: {} };
  },
};

describe("admin user routes", () => {
  let db: SQL;
  let handle: (path: string, role?: string) => Promise<Response>;

  beforeEach(async () => {
    db = new SQL(":memory:");
    await db`
      CREATE TABLE "user" (
        "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "email" TEXT NOT NULL,
        "emailVerified" INTEGER NOT NULL, "createdAt" DATE NOT NULL, "role" TEXT,
        "banned" INTEGER, "banReason" TEXT, "banExpires" DATE, "signupApproved" INTEGER
      )
    `;
    await db`
      INSERT INTO "user" VALUES
        ('u1', 'Ada', 'ada@example.com', 1, '2026-01-01T00:00:01.000Z', 'admin', 0, NULL, NULL, 1),
        ('u2', 'Bob', 'bob@example.com', 1, '2026-01-01T00:00:02.000Z', 'admin', 1, 'spam', NULL, 1)
    `;
    const app = new Elysia()
      .onError(({ code, error, set }) => {
        if (error instanceof AppException) {
          set.status = error.statusCode;
          return { code: error.code };
        }
        if (code === "VALIDATION") {
          set.status = 400;
          return { code: "VALIDATION_ERROR" };
        }
        return undefined;
      })
      .use(adminUserRoutes({ auth, users: new AdminUsersService(db, "sqlite") }));
    handle = (path, role) =>
      app.handle(new Request(`http://localhost${path}`, { headers: role ? { "x-test-role": role } : {} }));
  });

  afterEach(async () => {
    await db.close();
  });

  test("requires an administrator", async () => {
    expect((await handle("/admin/users")).status).toBe(401);
    expect((await handle("/admin/users", "user")).status).toBe(403);
  });

  test("applies role and status together", async () => {
    const response = await handle("/admin/users?role=admin&status=active&limit=10&offset=0", "admin");
    expect(response.status).toBe(200);
    const page = await response.json() as { items: Array<{ id: string; banned: boolean }>; total: number };
    expect(page.items).toEqual([expect.objectContaining({ id: "u1", banned: false })]);
    expect(page.total).toBe(1);
  });

  test("rejects unknown sort fields, statuses, and out-of-range limits", async () => {
    for (const query of ["sortBy=password", "status=deleted", "sortDirection=up", "limit=0", "limit=101", "offset=-1", "searchField=role"]) {
      expect((await handle(`/admin/users?${query}`, "admin")).status, query).toBe(400);
    }
  });
});
