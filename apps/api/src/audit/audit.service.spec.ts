import { afterEach, describe, expect, mock, test } from "bun:test";
import { SQL } from "bun";
import type { QueryRunner } from "typeorm";
import type { AuthSession } from "../auth/auth.service";
import { initializeDesktopSchema } from "../database/desktop-schema";
import { InitAuditLogs1720300000000 } from "../migrations/1720300000000-InitAuditLogs";
import { recordAudit, recordAuditLater } from "./audit-events";
import { AppException } from "@podosoft/podokit-contracts";
import { AuditService, parseRetentionDays, type AuditLogger, type AuditLogQuery } from "./audit.service";

const on = (): Promise<boolean> => Promise.resolve(true);
const off = (): Promise<boolean> => Promise.resolve(false);

let open: SQL | undefined;

afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function sqliteDatabase(): Promise<SQL> {
  const sql = new SQL(":memory:");
  open = sql;
  const runner = {
    connection: { options: { type: "better-sqlite3" } },
    query: (query: string): Promise<unknown> => sql.unsafe(query),
  } as unknown as QueryRunner;
  await new InitAuditLogs1720300000000().up(runner);
  return sql;
}

interface SeedRow {
  id: string;
  action: string;
  createdAt: string;
  actorEmail?: string;
  targetLabel?: string;
}

const at = (second: number): string => `2026-01-01T00:00:0${second}.000Z`;

// Newest first: a5, a4, then a3 and a2 sharing one timestamp, then a1.
const SEED: SeedRow[] = [
  { id: "a1", action: "auth.login", createdAt: at(1), actorEmail: "admin@example.com" },
  { id: "a2", action: "user.ban", createdAt: at(2), actorEmail: "admin@example.com", targetLabel: "bob@example.com" },
  { id: "a3", action: "auth.login", createdAt: at(2), actorEmail: "bob@example.com" },
  { id: "a4", action: "user.ban", createdAt: at(3), actorEmail: "admin@example.com", targetLabel: "carol@example.com" },
  { id: "a5", action: "auth.login", createdAt: at(4), actorEmail: "admin@example.com" },
];

async function seededService(): Promise<AuditService> {
  const sql = await sqliteDatabase();
  for (const row of SEED) {
    await sql`
      INSERT INTO "audit_logs" ("id", "action", "actorEmail", "targetLabel", "createdAt")
      VALUES (${row.id}, ${row.action}, ${row.actorEmail ?? null}, ${row.targetLabel ?? null}, ${row.createdAt})
    `;
  }
  return new AuditService(sql, { dialect: "sqlite", enabled: on });
}

async function walk(service: AuditService, query: AuditLogQuery): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: string | undefined;
  do {
    const page = await service.list({ ...query, cursor });
    pages.push(page.entries.map((entry) => entry.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor && pages.length < 10);
  return pages;
}

async function storedRows(sql: SQL): Promise<Array<{ action: string; metadata: unknown }>> {
  return sql<Array<{ action: string; metadata: unknown }>>`
    SELECT "action", "metadata" FROM "audit_logs" ORDER BY "createdAt", "action"
  `;
}

// Captures each INSERT's rows as the service binds them, so batching and the
// PostgreSQL encoding can be checked without a server.
function sqlCapture(): { sql: SQL; batches: Array<Array<Record<string, unknown>>>; failNext: () => void } {
  const batches: Array<Array<Record<string, unknown>>> = [];
  let fail = false;
  const tag = (first: unknown, ...rest: unknown[]): unknown => {
    if (Array.isArray(first) && "raw" in first) {
      if (fail) {
        fail = false;
        return Promise.reject(new Error("database unavailable"));
      }
      for (const value of rest) {
        const helper = value as { rows?: Array<Record<string, unknown>> };
        if (helper.rows) batches.push(helper.rows);
      }
      return Promise.resolve([]);
    }
    return { rows: first };
  };
  return { sql: tag as unknown as SQL, batches, failNext: () => { fail = true; } };
}

function warnings(): { logger: AuditLogger; messages: string[] } {
  const messages: string[] = [];
  return { logger: { warn: (_details, message) => { messages.push(message); } }, messages };
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition");
    await Bun.sleep(5);
  }
}

describe("AuditService", () => {
  test("[TC-PDDESKTOP-002] persists dates and nested metadata through SQLite", async () => {
    const sql = new SQL("sqlite://:memory:");
    try {
      await initializeDesktopSchema(sql);
      const service = new AuditService(sql, { dialect: "sqlite", enabled: on });
      await service.record({ action: "host.create", targetLabel: "example", metadata: { labels: ["one"], nested: { enabled: true } } });
      const { entries } = await service.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.metadata).toEqual({ labels: ["one"], nested: { enabled: true } });
      expect(Date.parse(entries[0]?.createdAt ?? "")).not.toBeNaN();
    } finally { await sql.close(); }
  });
  test("writes global audit events through one recorder", async () => {
    const sql = await sqliteDatabase();
    const service = new AuditService(sql, { dialect: "sqlite", enabled: on });
    service.connect();
    try {
      await recordAudit({ action: "invoice.paid", actorId: "user-1", metadata: { amount: 42 } });
      const [row] = await storedRows(sql);
      expect(row?.action).toBe("invoice.paid");
      expect(row?.metadata).toBe('{"amount":42}');
    } finally {
      await service.close();
    }
  });

  test("binds PostgreSQL metadata as an object so jsonb stores an object", async () => {
    const capture = sqlCapture();
    await new AuditService(capture.sql, { dialect: "postgres", enabled: on })
      .record({ action: "invoice.paid", metadata: { amount: 42 } });
    expect(capture.batches).toHaveLength(1);
    expect(capture.batches[0]?.[0]).toMatchObject({ action: "invoice.paid", metadata: { amount: 42 } });
  });

  test("lists entries with serialized timestamps and parsed metadata", async () => {
    const sql = await sqliteDatabase();
    const service = new AuditService(sql, { dialect: "sqlite", enabled: on });
    await service.record({ action: "auth.login", metadata: { method: "password" } });
    const [entry] = (await service.list()).entries;
    expect(entry?.metadata).toEqual({ method: "password" });
    expect(entry?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("does not propagate persistence failures", async () => {
    const sql = mock((first: unknown) =>
      Array.isArray(first) && "raw" in first ? Promise.reject(new Error("database unavailable")) : {}
    ) as unknown as SQL;
    const service = new AuditService(sql, { dialect: "postgres", enabled: on });
    await expect(service.record({ action: "auth.login" })).resolves.toBeUndefined();
  });

  test("record() skips the write while the toggle is off", async () => {
    const sql = await sqliteDatabase();
    await new AuditService(sql, { dialect: "sqlite", enabled: off }).record({ action: "invoice.paid" });
    expect(await storedRows(sql)).toHaveLength(0);
  });

  test("every write path goes through the toggle in record()", async () => {
    const sql = await sqliteDatabase();
    let enabled = false;
    const service = new AuditService(sql, { dialect: "sqlite", enabled: () => Promise.resolve(enabled) });
    const session: AuthSession = { user: { id: "user-1", email: "a@example.com" }, session: {} };
    service.connect();
    try {
      await recordAudit({ action: "invoice.paid" });
      await service.recordRequest("todo.create", new Request("http://localhost/todos"), session);
      expect(await storedRows(sql)).toHaveLength(0);

      enabled = true;
      await recordAudit({ action: "invoice.paid" });
      await service.recordRequest("todo.create", new Request("http://localhost/todos"), session);
      expect((await storedRows(sql)).map((row) => row.action).sort()).toEqual(["invoice.paid", "todo.create"]);
    } finally {
      await service.close();
    }
  });

  test("a failing toggle read never breaks the caller", async () => {
    const sql = await sqliteDatabase();
    const service = new AuditService(sql, {
      dialect: "sqlite",
      enabled: () => Promise.reject(new Error("store down")),
    });
    await expect(service.record({ action: "auth.login" })).resolves.toBeUndefined();
  });
});

describe("deferred recording", () => {
  test("writes a full batch with one INSERT without waiting for the timer", async () => {
    const capture = sqlCapture();
    const service = new AuditService(capture.sql, {
      dialect: "postgres",
      enabled: on,
      queue: { batchSize: 3, flushIntervalMs: 60_000 },
    });
    for (const id of ["1", "2", "3"]) service.recordLater({ action: "comment.create", targetId: id });
    await waitFor(() => capture.batches.length === 1);
    expect(capture.batches[0]?.map((row) => row.targetId)).toEqual(["1", "2", "3"]);
    await service.close();
    expect(capture.batches).toHaveLength(1);
  });

  test("writes a partial batch when the flush interval elapses", async () => {
    const capture = sqlCapture();
    const service = new AuditService(capture.sql, {
      dialect: "postgres",
      enabled: on,
      queue: { batchSize: 100, flushIntervalMs: 20 },
    });
    service.recordLater({ action: "comment.create" });
    service.recordLater({ action: "comment.update" });
    expect(capture.batches).toHaveLength(0);
    await waitFor(() => capture.batches.length === 1);
    expect(capture.batches[0]).toHaveLength(2);
    await service.close();
  });

  test("close() writes the entries still queued", async () => {
    const capture = sqlCapture();
    const service = new AuditService(capture.sql, {
      dialect: "postgres",
      enabled: on,
      queue: { flushIntervalMs: 60_000 },
    });
    service.connect();
    recordAuditLater({ action: "comment.create" });
    service.recordLater({ action: "comment.delete" });
    expect(capture.batches).toHaveLength(0);
    await service.close();
    expect(capture.batches[0]?.map((row) => row.action)).toEqual(["comment.create", "comment.delete"]);
  });

  test("drops entries past the queue bound and records the loss", async () => {
    const capture = sqlCapture();
    const { logger, messages } = warnings();
    const service = new AuditService(capture.sql, {
      dialect: "postgres",
      enabled: on,
      logger,
      queue: { maxQueued: 2, batchSize: 100, flushIntervalMs: 60_000 },
    });
    for (let index = 0; index < 5; index += 1) service.recordLater({ action: "comment.create" });
    expect(messages).toEqual(["Audit queue is full; dropping deferred entries"]);
    await service.close();
    const batch = capture.batches[0] ?? [];
    expect(batch).toHaveLength(3);
    expect(batch[2]).toMatchObject({ action: "audit.dropped", metadata: { count: 3 } });
  });

  test("counts a failed batch and records the loss with the next write", async () => {
    const capture = sqlCapture();
    const { logger, messages } = warnings();
    const service = new AuditService(capture.sql, {
      dialect: "postgres",
      enabled: on,
      logger,
      queue: { flushIntervalMs: 60_000 },
    });
    capture.failNext();
    service.recordLater({ action: "comment.create" });
    service.recordLater({ action: "comment.create" });
    await service.flush();
    expect(capture.batches).toHaveLength(0);
    expect(messages).toEqual(["Audit batch write failed"]);

    service.recordLater({ action: "comment.update" });
    await service.close();
    expect(capture.batches[0]).toEqual([
      expect.objectContaining({ action: "comment.update" }),
      expect.objectContaining({ action: "audit.dropped", metadata: { count: 2 } }),
    ]);
  });

  test("discards deferred entries while the toggle is off", async () => {
    const capture = sqlCapture();
    const service = new AuditService(capture.sql, { dialect: "postgres", enabled: off });
    service.recordLater({ action: "comment.create" });
    await service.close();
    expect(capture.batches).toHaveLength(0);
  });

  test("recordRequest() queues the entry when asked to defer", async () => {
    const capture = sqlCapture();
    const service = new AuditService(capture.sql, {
      dialect: "postgres",
      enabled: on,
      queue: { flushIntervalMs: 60_000 },
    });
    const session: AuthSession = { user: { id: "user-1", email: "a@example.com" }, session: {} };
    await service.recordRequest("comment.create", new Request("http://localhost/comments"), session, {}, {
      defer: true,
    });
    expect(capture.batches).toHaveLength(0);
    await service.close();
    expect(capture.batches[0]?.[0]).toMatchObject({ action: "comment.create", actorEmail: "a@example.com" });
  });
});

describe("listing", () => {
  test("walks every entry once, newest first, across a timestamp tie", async () => {
    const service = await seededService();
    expect(await walk(service, { limit: 2 })).toEqual([["a5", "a4"], ["a3", "a2"], ["a1"]]);
    expect(await walk(service, { limit: 3 })).toEqual([["a5", "a4", "a3"], ["a2", "a1"]]);
  });

  test("gives no cursor when the last page is exactly full", async () => {
    const service = await seededService();
    const page = await service.list({ limit: 5 });
    expect(page.entries).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
  });

  test("walks oldest first when asked", async () => {
    const service = await seededService();
    expect(await walk(service, { limit: 2, order: "asc" })).toEqual([["a1", "a2"], ["a3", "a4"], ["a5"]]);
  });

  test("keeps the page size between 1 and 100", async () => {
    const service = await seededService();
    expect((await service.list({ limit: 0 })).entries).toHaveLength(1);
    expect((await service.list({ limit: 1_000 })).entries).toHaveLength(5);
  });

  test("filters by exact action, actor email, and target label", async () => {
    const service = await seededService();
    const ids = async (query: AuditLogQuery): Promise<string[]> =>
      (await service.list(query)).entries.map((entry) => entry.id);
    expect(await ids({ action: "user.ban" })).toEqual(["a4", "a2"]);
    expect(await ids({ actor: "admin@example.com" })).toEqual(["a5", "a4", "a2", "a1"]);
    expect(await ids({ target: "bob@example.com" })).toEqual(["a2"]);
    expect(await ids({ actor: "admin" })).toEqual([]);
    expect(await walk(service, { action: "auth.login", actor: "admin@example.com", limit: 1 }))
      .toEqual([["a5"], ["a1"]]);
  });

  test("lists each recorded action code once", async () => {
    const service = await seededService();
    expect(await service.actions()).toEqual(["auth.login", "user.ban"]);
  });

  test("rejects a cursor it did not issue", async () => {
    const service = await seededService();
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const cursor of ["%%%", encode({ id: "a1" }), encode(["yesterday", "a1"]), encode([at(1), 7])]) {
      const error = await service.list({ cursor }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AppException);
      expect(error).toMatchObject({ code: "INVALID_CURSOR", statusCode: 400 });
    }
    const postgres = new AuditService(sqlCapture().sql, { dialect: "postgres", enabled: on });
    await expect(postgres.list({ cursor: encode([at(1), "a1"]) })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
});

describe("retention", () => {
  const DAY = 24 * 60 * 60 * 1_000;
  const now = Date.parse("2026-06-01T00:00:00.000Z");

  async function aged(sql: SQL, ages: number[]): Promise<void> {
    for (const [index, days] of ages.entries()) {
      await sql`
        INSERT INTO "audit_logs" ("id", "action", "createdAt")
        VALUES (${`r${index}`}, ${"auth.login"}, ${new Date(now - days * DAY).toISOString()})
      `;
    }
  }

  // Counts DELETE statements while passing every call through to the database.
  function counting(sql: SQL): { sql: SQL; deletes: () => number } {
    let deletes = 0;
    const call = sql as unknown as (...args: unknown[]) => unknown;
    const wrapped = (first: unknown, ...rest: unknown[]): unknown => {
      if (Array.isArray(first) && "raw" in first && first.join("").includes("DELETE")) deletes += 1;
      return call(first, ...rest);
    };
    return { sql: wrapped as unknown as SQL, deletes: () => deletes };
  }

  test("reads AUDIT_LOG_RETENTION_DAYS, keeping entries forever by default", () => {
    expect(parseRetentionDays(undefined)).toBe(0);
    expect(parseRetentionDays(" ")).toBe(0);
    expect(parseRetentionDays("0")).toBe(0);
    expect(parseRetentionDays("90")).toBe(90);
    for (const value of ["-1", "1.5", "ninety"]) expect(() => parseRetentionDays(value)).toThrow();
  });

  test("deletes old entries in bounded batches and records the prune", async () => {
    const sql = await sqliteDatabase();
    await aged(sql, [40, 39, 38, 35, 31, 29, 1]);
    const { sql: wrapped, deletes } = counting(sql);
    const service = new AuditService(wrapped, {
      dialect: "sqlite",
      enabled: on,
      retention: { days: 30, batchSize: 2 },
    });
    expect(await service.prune(now)).toBe(5);
    expect(deletes()).toBe(3);
    const left = await sql<Array<{ id: string; action: string; metadata: string | null }>>`
      SELECT "id", "action", "metadata" FROM "audit_logs" ORDER BY "id"
    `;
    expect(left.filter((row) => row.action === "auth.login").map((row) => row.id)).toEqual(["r5", "r6"]);
    const pruned = left.find((row) => row.action === "audit.pruned");
    expect(JSON.parse(pruned?.metadata ?? "{}")).toEqual({
      count: 5,
      before: new Date(now - 30 * DAY).toISOString(),
    });
  });

  test("keeps every entry when no retention period is set", async () => {
    const sql = await sqliteDatabase();
    await aged(sql, [4_000]);
    const { sql: wrapped, deletes } = counting(sql);
    const service = new AuditService(wrapped, { dialect: "sqlite", enabled: on });
    service.connect();
    await service.close();
    expect(await service.prune(now)).toBe(0);
    expect(deletes()).toBe(0);
    expect(await storedRows(sql)).toHaveLength(1);
  });

  test("prunes from connect() on a timer until close()", async () => {
    const sql = await sqliteDatabase();
    await aged(sql, [400, 400]);
    const service = new AuditService(sql, {
      dialect: "sqlite",
      enabled: off,
      retention: { days: 30, intervalMs: 20 },
    });
    service.connect();
    const deadline = Date.now() + 1_000;
    while ((await storedRows(sql)).length > 0 && Date.now() < deadline) await Bun.sleep(5);
    expect(await storedRows(sql)).toHaveLength(0);

    await service.close();
    await aged(sql, [400]);
    await Bun.sleep(60);
    expect(await storedRows(sql)).toHaveLength(1);
  });
});
