import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { AdminSessionsService, type AdminSessionView } from "./admin-sessions.service";

const DAY_MS = 86_400_000;

interface SeedSession {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt?: string;
}

async function createSchema(db: SQL): Promise<void> {
  await db`CREATE TABLE "user" ("id" TEXT PRIMARY KEY, "email" TEXT NOT NULL, "name" TEXT NOT NULL)`;
  await db`
    CREATE TABLE "session" (
      "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "token" TEXT NOT NULL,
      "ipAddress" TEXT, "userAgent" TEXT, "impersonatedBy" TEXT,
      "createdAt" TEXT NOT NULL, "expiresAt" TEXT NOT NULL
    )
  `;
}

async function seed(db: SQL, sessions: SeedSession[]): Promise<void> {
  const future = new Date(Date.now() + DAY_MS).toISOString();
  for (const session of sessions) {
    await db`
      INSERT INTO "session" VALUES (
        ${session.id}, ${session.userId}, ${`token-${session.id}`}, '203.0.113.7', 'Agent', NULL,
        ${session.createdAt}, ${session.expiresAt ?? future}
      )
    `;
  }
}

async function collect(service: AdminSessionsService, limit: number, search?: string): Promise<{
  pages: number;
  items: AdminSessionView[];
}> {
  const items: AdminSessionView[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await service.list({ limit, cursor, search });
    pages += 1;
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { pages, items };
}

describe("AdminSessionsService", () => {
  let db: SQL;
  let service: AdminSessionsService;

  beforeEach(async () => {
    db = new SQL(":memory:");
    await createSchema(db);
    await db`
      INSERT INTO "user" VALUES
        ('alice', 'alice@example.com', 'Alice Smith'),
        ('bob', 'bob_admin@example.com', 'Bob'),
        ('carol', 'carol@example.com', 'Carol 100%')
    `;
    service = new AdminSessionsService(db, "sqlite");
  });

  afterEach(async () => {
    await db.close();
  });

  test("pages through every active session newest first without gaps or repeats", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const owners = ["alice", "bob", "carol"];
    // Pairs share a creation time so the id tiebreaker decides the order.
    await seed(db, Array.from({ length: 11 }, (_, index) => ({
      id: `s${String(index).padStart(2, "0")}`,
      userId: owners[index % owners.length] ?? "alice",
      createdAt: new Date(base + Math.floor(index / 2) * 1_000).toISOString(),
    })));

    const { pages, items } = await collect(service, 4);

    expect(pages).toBe(3);
    expect(items.map((item) => item.id)).toEqual([
      "s10", "s09", "s08", "s07", "s06", "s05", "s04", "s03", "s02", "s01", "s00",
    ]);
    const first = await service.list({ limit: 4 });
    expect(first.total).toBe(11);
    expect(first.nextCursor).toEqual(expect.any(String));
  });

  test("returns only active sessions", async () => {
    await seed(db, [
      { id: "live", userId: "alice", createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "expired",
        userId: "alice",
        createdAt: "2026-01-02T00:00:00.000Z",
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
    ]);

    const page = await service.list();

    expect(page.items.map((item) => item.id)).toEqual(["live"]);
    expect(page.total).toBe(1);
    expect(page.nextCursor).toBeNull();
  });

  test("searches the user's email or name case-insensitively and literally", async () => {
    await seed(db, [
      { id: "a", userId: "alice", createdAt: "2026-01-01T00:00:01.000Z" },
      { id: "b", userId: "bob", createdAt: "2026-01-01T00:00:02.000Z" },
      { id: "c", userId: "carol", createdAt: "2026-01-01T00:00:03.000Z" },
    ]);

    expect((await service.list({ search: "ALICE@" })).items.map((item) => item.id)).toEqual(["a"]);
    expect((await service.list({ search: "smith" })).items.map((item) => item.id)).toEqual(["a"]);
    // LIKE wildcards in the query match themselves, not every row.
    expect((await service.list({ search: "_" })).items.map((item) => item.id)).toEqual(["b"]);
    expect((await service.list({ search: "%" })).items.map((item) => item.id)).toEqual(["c"]);
    expect((await service.list({ search: "  " })).total).toBe(3);
    const searched = await collect(service, 1, "example.com");
    expect(searched.items.map((item) => item.id)).toEqual(["c", "b", "a"]);
  });

  test("narrows the list to one user", async () => {
    await seed(db, [
      { id: "a1", userId: "alice", createdAt: "2026-01-01T00:00:01.000Z" },
      { id: "b1", userId: "bob", createdAt: "2026-01-01T00:00:02.000Z" },
      { id: "a2", userId: "alice", createdAt: "2026-01-01T00:00:03.000Z" },
    ]);

    const page = await service.list({ userId: "alice" });

    expect(page.items.map((item) => item.id)).toEqual(["a2", "a1"]);
    expect(page.total).toBe(2);
  });

  test("returns user details without the session token", async () => {
    await seed(db, [{ id: "a", userId: "alice", createdAt: "2026-01-01T00:00:01.000Z" }]);

    const [item] = (await service.list()).items;

    expect(item).toEqual({
      id: "a",
      userId: "alice",
      userEmail: "alice@example.com",
      userName: "Alice Smith",
      ipAddress: "203.0.113.7",
      userAgent: "Agent",
      impersonatedBy: null,
      createdAt: "2026-01-01T00:00:01.000Z",
      expiresAt: expect.any(String),
    });
    expect(JSON.stringify(item)).not.toContain("token-a");
  });

  test("rejects a cursor it did not issue", async () => {
    await expect(service.list({ cursor: "not-a-cursor" }))
      .rejects.toMatchObject({ code: "ADMIN_SESSION_CURSOR_INVALID", statusCode: 400 });
    const forged = Buffer.from(JSON.stringify(["not a date", "id"])).toString("base64url");
    await expect(service.list({ cursor: forged }))
      .rejects.toMatchObject({ code: "ADMIN_SESSION_CURSOR_INVALID", statusCode: 400 });
  });

  test("keeps the page size within bounds", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    await seed(db, Array.from({ length: 3 }, (_, index) => ({
      id: `s${index}`,
      userId: "alice",
      createdAt: new Date(base + index * 1_000).toISOString(),
    })));

    expect((await service.list({ limit: 0 })).items).toHaveLength(1);
    expect((await service.list({ limit: 1_000 })).items).toHaveLength(3);
  });

  test("looks up a session token by id on the server", async () => {
    await seed(db, [{ id: "a", userId: "alice", createdAt: "2026-01-01T00:00:01.000Z" }]);

    expect(await service.tokenOf("a")).toBe("token-a");
    expect(await service.tokenOf("missing")).toBeNull();
  });
});
