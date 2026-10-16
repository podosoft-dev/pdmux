import { afterEach, beforeEach, describe, expect, mock, test, type Mock } from "bun:test";
import { SQL } from "bun";
import { AppException } from "@podosoft/podokit-contracts";
import { Elysia } from "elysia";
import type { AuthService, AuthSession } from "../auth/auth.service";
import { AdminSessionsService } from "../admin-sessions/admin-sessions.service";
import {
  accountSessionRoutes,
  type AccountSessionPage,
  type OwnSessionRevoker,
} from "./account-sessions.routes";

// More sessions than Better Auth's /list-sessions returns.
const OTHER_SESSIONS = 150;
const DAY_MS = 86_400_000;

// Callers name their session with a test header; its row says whose it is.
function authFor(db: SQL): Pick<AuthService, "requireSession"> {
  return {
    requireSession: async (request: Request): Promise<AuthSession> => {
      const id = request.headers.get("x-test-session");
      const [row] = id
        ? await db<Array<{ userId: string; createdAt: string }>>`
            SELECT "userId", "createdAt" FROM "session" WHERE "id" = ${id}
          `
        : [];
      if (!row) throw new AppException("AUTH_REQUIRED", "Authentication is required", 401);
      return { user: { id: row.userId }, session: { id, createdAt: row.createdAt } };
    },
  };
}

describe("account session routes", () => {
  let db: SQL;
  let revoke: Mock<OwnSessionRevoker>;
  let freshAge: number;
  let handle: (request: Request) => Promise<Response>;
  const now = Date.now();

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
    await db`INSERT INTO "user" VALUES ('user-1', 'one@example.com', 'One'), ('user-2', 'two@example.com', 'Two')`;
    const expires = new Date(now + DAY_MS).toISOString();
    // The current session is the oldest, so newest-first paging would put it last.
    await db`
      INSERT INTO "session" VALUES ('current', 'user-1', 'secret-current', '203.0.113.7', 'Agent',
        NULL, ${new Date(now - 60_000).toISOString()}, ${expires})
    `;
    for (let index = 0; index < OTHER_SESSIONS; index += 1) {
      await db`
        INSERT INTO "session" VALUES (${`other-${index}`}, 'user-1', ${`secret-${index}`}, NULL, NULL, NULL,
          ${new Date(now - 30_000 + index).toISOString()}, ${expires})
      `;
    }
    await db`
      INSERT INTO "session" VALUES ('foreign', 'user-2', 'secret-foreign', NULL, NULL, NULL,
        ${new Date(now).toISOString()}, ${expires})
    `;
    revoke = mock<OwnSessionRevoker>(async () => undefined);
    freshAge = 86_400;
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
      .use(accountSessionRoutes({
        auth: authFor(db),
        sessions: new AdminSessionsService(db, "sqlite"),
        revoke,
        freshAgeSeconds: async () => freshAge,
      }));
    handle = (request) => app.handle(request);
  });

  afterEach(async () => {
    await db.close();
  });

  async function send(path: string, init: RequestInit = {}, session: string | null = "current"): Promise<Response> {
    const headers = new Headers(init.headers);
    if (session) headers.set("x-test-session", session);
    return handle(new Request(`http://localhost${path}`, { ...init, headers }));
  }

  test("returns the current session on every page and pages through every other one", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response = await send(`/account/sessions?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("secret-");
      const page = JSON.parse(text) as AccountSessionPage;
      expect(page.current).toMatchObject({ id: "current", ipAddress: "203.0.113.7", userAgent: "Agent" });
      expect(page.total).toBe(OTHER_SESSIONS + 1);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(2);
    expect(seen).toHaveLength(OTHER_SESSIONS);
    expect(new Set(seen).size).toBe(OTHER_SESSIONS);
    expect(seen).not.toContain("current");
    expect(seen).not.toContain("foreign");
    expect(seen[0]).toBe(`other-${OTHER_SESSIONS - 1}`);
  });

  test("refuses anonymous callers and a session too old to list sessions", async () => {
    expect((await send("/account/sessions", {}, null)).status).toBe(401);
    await db`UPDATE "session" SET "createdAt" = ${new Date(now - 2 * DAY_MS).toISOString()} WHERE "id" = 'current'`;
    const stale = await send("/account/sessions");
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ code: "SESSION_NOT_FRESH" });
    freshAge = 0;
    expect((await send("/account/sessions")).status).toBe(200);
  });

  test("revokes one of the caller's sessions by id with the token looked up on the server", async () => {
    const response = await send("/account/sessions/other-3", { method: "DELETE", headers: { cookie: "session=1" } });

    expect(response.status).toBe(204);
    expect(revoke).toHaveBeenCalledTimes(1);
    const [token, headers] = revoke.mock.calls[0] ?? [];
    expect(token).toBe("secret-3");
    expect(headers?.get("cookie")).toBe("session=1");
  });

  test("does not reveal or revoke another user's session", async () => {
    const response = await send("/account/sessions/foreign", { method: "DELETE" });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "ACCOUNT_SESSION_NOT_FOUND" });
    expect(revoke).not.toHaveBeenCalled();
  });
});
