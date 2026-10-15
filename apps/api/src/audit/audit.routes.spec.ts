import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { AppException } from "@podosoft/podokit-contracts";
import { Elysia } from "elysia";
import type { QueryRunner } from "typeorm";
import { InitAuditLogs1720300000000 } from "../migrations/1720300000000-InitAuditLogs";
import { AUDIT_NEXT_CURSOR_HEADER, auditRoutes } from "./audit.routes";
import { AuditService } from "./audit.service";

let open: SQL | undefined;

afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function service(entries: number): Promise<AuditService> {
  const sql = new SQL(":memory:");
  open = sql;
  const runner = {
    connection: { options: { type: "better-sqlite3" } },
    query: (query: string): Promise<unknown> => sql.unsafe(query),
  } as unknown as QueryRunner;
  await new InitAuditLogs1720300000000().up(runner);
  for (let index = 0; index < entries; index += 1) {
    await sql`
      INSERT INTO "audit_logs" ("id", "action", "actorEmail", "createdAt")
      VALUES (${`e${index}`}, ${index % 2 ? "user.ban" : "auth.login"}, ${"admin@example.com"},
              ${new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()})
    `;
  }
  return new AuditService(sql, { dialect: "sqlite", enabled: () => Promise.resolve(true) });
}

type Get = (path: string) => Promise<Response>;

function app(audit: AuditService, admin = true): Get {
  const server = new Elysia()
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
    .use(auditRoutes(audit, () =>
      admin
        ? Promise.resolve()
        : Promise.reject(new AppException("ADMIN_REQUIRED", "Administrator access is required", 403))
    ));
  return (path) => server.handle(new Request(`http://localhost${path}`));
}

describe("GET /audit-logs", () => {
  test("returns an array and the next cursor in a header until the last page", async () => {
    const get = app(await service(5));
    const seen: string[] = [];
    let path = "/audit-logs?limit=2";
    for (let pages = 0; pages < 5; pages += 1) {
      const response = await get(path);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Array<{ id: string }>;
      expect(Array.isArray(body)).toBe(true);
      seen.push(...body.map((entry) => entry.id));
      const next = response.headers.get(AUDIT_NEXT_CURSOR_HEADER);
      if (!next) break;
      path = `/audit-logs?limit=2&cursor=${encodeURIComponent(next)}`;
    }
    expect(seen).toEqual(["e4", "e3", "e2", "e1", "e0"]);
  });

  test("lists newest first unless order=asc", async () => {
    const get = app(await service(3));
    const ids = async (path: string): Promise<string[]> =>
      ((await (await get(path)).json()) as Array<{ id: string }>).map((entry) => entry.id);
    expect(await ids("/audit-logs")).toEqual(["e2", "e1", "e0"]);
    expect(await ids("/audit-logs?order=desc")).toEqual(["e2", "e1", "e0"]);
    expect(await ids("/audit-logs?order=asc")).toEqual(["e0", "e1", "e2"]);
  });

  test("filters on the server", async () => {
    const get = app(await service(4));
    const body = (await (await get("/audit-logs?action=user.ban")).json()) as Array<{ action: string }>;
    expect(body.map((entry) => entry.action)).toEqual(["user.ban", "user.ban"]);
  });

  test("rejects out-of-range or malformed parameters", async () => {
    const get = app(await service(1));
    for (const query of ["limit=101", "limit=0", "limit=1.5", "order=sideways"]) {
      const response = await get(`/audit-logs?${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "VALIDATION_ERROR" });
    }
    const response = await get("/audit-logs?cursor=not-a-cursor");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_CURSOR" });
  });

  test("is admin-only", async () => {
    const get = app(await service(1), false);
    expect((await get("/audit-logs")).status).toBe(403);
    expect((await get("/audit-logs/actions")).status).toBe(403);
  });
});

describe("GET /audit-logs/actions", () => {
  test("lists the recorded action codes", async () => {
    const get = app(await service(3));
    expect(await (await get("/audit-logs/actions")).json()).toEqual(["auth.login", "user.ban"]);
  });
});
