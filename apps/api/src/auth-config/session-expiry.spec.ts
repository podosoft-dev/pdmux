import { afterEach, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { resetSessionExpirations } from "./session-expiry";

let open: SQL | undefined;

afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe("session expiry reset on SQLite", () => {
  it("moves active sessions to the new lifetime and leaves expired ones", async () => {
    const sql = new SQL(":memory:");
    open = sql;
    // Better Auth stores SQLite dates as ISO 8601 text.
    await sql`CREATE TABLE "session" ("id" text PRIMARY KEY, "expiresAt" date NOT NULL, "updatedAt" date NOT NULL)`;
    const now = new Date("2026-10-15T10:00:00.000Z");
    const active = new Date(now.getTime() + 3_600_000).toISOString();
    const expired = new Date(now.getTime() - 1_000).toISOString();
    await sql`INSERT INTO "session" VALUES (${"active"}, ${active}, ${active}), (${"expired"}, ${expired}, ${expired})`;

    await resetSessionExpirations(sql, "sqlite", 1_800, now);

    const rows = await sql<Array<{ id: string; expiresAt: string; updatedAt: string }>>`
      SELECT "id", "expiresAt", "updatedAt" FROM "session" ORDER BY "id"
    `;
    expect(rows).toEqual([
      { id: "active", expiresAt: "2026-10-15T10:30:00.000Z", updatedAt: now.toISOString() },
      { id: "expired", expiresAt: expired, updatedAt: expired },
    ]);
  });
});
