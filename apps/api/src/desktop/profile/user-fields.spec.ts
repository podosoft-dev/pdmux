import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { DESKTOP_USER_FIELDS } from "./user-fields";

type UserFields = NonNullable<NonNullable<BetterAuthOptions["user"]>["additionalFields"]>;

// The query the MCP authority runs for a user's role and ban. Rows are inserted with
// the values Better Auth fills in for the desktop's required fields.
const AUTHORITY_QUERY = 'SELECT "role", "banned", "banExpires" FROM "user" WHERE "id" = ?';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function database(): Database {
  const root = mkdtempSync(join(tmpdir(), "pdmux-desktop-user-"));
  roots.push(root);
  return new Database(join(root, "pdmux.sqlite"));
}

async function migrate(db: Database, fields: UserFields): Promise<void> {
  const migrations = await getMigrations({
    database: db,
    secret: "desktop-user-fields-test-secret-with-32-characters",
    baseURL: "http://127.0.0.1:5002",
    user: { additionalFields: fields },
  });
  await migrations.runMigrations();
}

function columns(db: Database): string[] {
  return (db.query('PRAGMA table_info("user")').all() as { name: string }[]).map((column) => column.name);
}

function insertUser(db: Database, id: string): void {
  db.run(
    'INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "role", "signupApproved") VALUES (?, ?, ?, 0, ?, ?, ?, 1)',
    [id, "Local", `${id}@example.com`, "2026-10-18T00:00:00.000Z", "2026-10-18T00:00:00.000Z", "user"],
  );
}

describe("[TC-PDDESKTOP-022] the desktop schema keeps the user columns shared server code reads", () => {
  it("creates the ban columns the MCP authority selects on a new desktop database", async () => {
    const db = database();
    await migrate(db, DESKTOP_USER_FIELDS);
    expect(columns(db)).toEqual(expect.arrayContaining(["role", "signupApproved", "banned", "banReason", "banExpires"]));

    insertUser(db, "local");
    const row = db.query(AUTHORITY_QUERY).get("local") as Record<string, unknown>;
    // Without the columns SQLite reads the quoted names as strings, under keys such as '"banned"'.
    expect(Object.keys(row)).toEqual(["role", "banned", "banExpires"]);
    expect(row.role).toBe("user");
    expect(Boolean(row.banned)).toBe(false);
    expect(row.banExpires).toBeNull();
    db.close();
  });

  it("adds them to a desktop database created with only the role and approval columns", async () => {
    const db = database();
    await migrate(db, {
      role: { type: "string", defaultValue: "user", input: false },
      signupApproved: { type: "boolean", defaultValue: true, input: false },
    });
    expect(columns(db)).not.toContain("banned");
    insertUser(db, "existing");

    await migrate(db, DESKTOP_USER_FIELDS);
    expect(columns(db)).toEqual(expect.arrayContaining(["banned", "banReason", "banExpires"]));
    const row = db.query(AUTHORITY_QUERY).get("existing") as Record<string, unknown>;
    expect(Object.keys(row)).toEqual(["role", "banned", "banExpires"]);
    expect(row.banExpires).toBeNull();
    db.close();
  });
});
