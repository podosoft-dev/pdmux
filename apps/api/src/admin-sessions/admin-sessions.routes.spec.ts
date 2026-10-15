import { afterEach, beforeEach, describe, expect, mock, test, type Mock } from "bun:test";
import { SQL } from "bun";
import { AppException } from "@podosoft/podokit-contracts";
import { Elysia } from "elysia";
import type { AuthService, AuthSession } from "../auth/auth.service";
import { adminSessionRoutes, type SessionRevoker } from "./admin-sessions.routes";
import { AdminSessionsService } from "./admin-sessions.service";

type Auth = Pick<AuthService, "requireAdmin">;

// Callers identify themselves with a test header; only "admin" passes.
const auth: Auth = {
  requireAdmin: async (request: Request): Promise<AuthSession> => {
    const role = request.headers.get("x-test-role");
    if (!role) throw new AppException("AUTH_REQUIRED", "Authentication is required", 401);
    if (role !== "admin") throw new AppException("ADMIN_REQUIRED", "Administrator access is required", 403);
    return { user: { id: "admin-1", role: "admin" }, session: {} };
  },
};

interface Reply {
  status: number;
  text: string;
}

describe("admin session routes", () => {
  let db: SQL;
  let revoke: Mock<SessionRevoker>;
  let handle: (request: Request) => Promise<Response>;

  beforeEach(async () => {
    db = new SQL(":memory:");
    await db`CREATE TABLE "user" ("id" TEXT PRIMARY KEY, "email" TEXT NOT NULL, "name" TEXT NOT NULL)`;
    await db`
      CREATE TABLE "session" (
        "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "token" TEXT NOT NULL,
        "ipAddress" TEXT, "userAgent" TEXT, "impersonatedBy" TEXT,
        "createdAt" TEXT NOT NULL, "expiresAt" TEXT NOT NULL
      )
    `;
    await db`INSERT INTO "user" VALUES ('user-1', 'user@example.com', 'User')`;
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await db`
      INSERT INTO "session" VALUES
        ('session-1', 'user-1', 'secret-token-1', NULL, NULL, NULL, '2026-01-01T00:00:01.000Z', ${future}),
        ('session-2', 'user-1', 'secret-token-2', NULL, NULL, NULL, '2026-01-01T00:00:02.000Z', ${future})
    `;
    revoke = mock<SessionRevoker>(async () => undefined);
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
      .use(adminSessionRoutes({ auth, sessions: new AdminSessionsService(db, "sqlite"), revoke }));
    handle = (request) => app.handle(request);
  });

  afterEach(async () => {
    await db.close();
  });

  async function send(path: string, init: RequestInit = {}, role: string | null = "admin"): Promise<Reply> {
    const headers = new Headers(init.headers);
    if (role) headers.set("x-test-role", role);
    const response = await handle(new Request(`http://localhost${path}`, { ...init, headers }));
    return { status: response.status, text: await response.text() };
  }

  test("lists sessions for administrators without exposing tokens", async () => {
    const reply = await send("/admin/sessions?limit=1");

    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.text) as { items: Array<{ id: string }>; nextCursor: string | null; total: number };
    expect(body.items.map((item) => item.id)).toEqual(["session-2"]);
    expect(body.total).toBe(2);
    expect(reply.text).not.toContain("secret-token");

    const next = await send(`/admin/sessions?limit=1&cursor=${encodeURIComponent(body.nextCursor ?? "")}`);
    expect(JSON.parse(next.text)).toMatchObject({ items: [{ id: "session-1" }], nextCursor: null });
  });

  test("refuses anonymous callers and non-administrators", async () => {
    expect((await send("/admin/sessions", {}, null)).status).toBe(401);
    expect((await send("/admin/sessions", {}, "user")).status).toBe(403);
    expect((await send("/admin/sessions/session-1", { method: "DELETE" }, "user")).status).toBe(403);
    expect(revoke).not.toHaveBeenCalled();
  });

  test("validates paging input", async () => {
    expect((await send("/admin/sessions?limit=1000")).status).toBe(400);
    expect(JSON.parse((await send("/admin/sessions?cursor=forged")).text))
      .toEqual({ code: "ADMIN_SESSION_CURSOR_INVALID" });
  });

  test("revokes by id with the token looked up on the server", async () => {
    const reply = await send("/admin/sessions/session-1", {
      method: "DELETE",
      headers: { cookie: "admin-session=1" },
    });

    expect(reply.status).toBe(204);
    expect(revoke).toHaveBeenCalledTimes(1);
    const [token, headers] = revoke.mock.calls[0] ?? [];
    expect(token).toBe("secret-token-1");
    expect(headers?.get("cookie")).toBe("admin-session=1");
  });

  test("reports an unknown session without revoking anything", async () => {
    const reply = await send("/admin/sessions/missing", { method: "DELETE" });

    expect(reply.status).toBe(404);
    expect(JSON.parse(reply.text)).toEqual({ code: "ADMIN_SESSION_NOT_FOUND" });
    expect(revoke).not.toHaveBeenCalled();
  });
});
