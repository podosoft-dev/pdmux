import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { AdminUsersService, type AdminUserQuery } from "./admin-users.service";

interface SeedUser {
  id: string;
  name: string;
  email: string;
  role?: string | null;
  banned?: boolean | null;
  signupApproved?: boolean | null;
  emailVerified?: boolean;
  createdAt: string;
}

// Better Auth stores booleans as 0 or 1 and dates as ISO text on SQLite.
async function createSchema(db: SQL): Promise<void> {
  await db`
    CREATE TABLE "user" (
      "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "email" TEXT NOT NULL,
      "emailVerified" INTEGER NOT NULL, "image" TEXT, "createdAt" DATE NOT NULL,
      "updatedAt" DATE NOT NULL, "role" TEXT, "banned" INTEGER, "banReason" TEXT,
      "banExpires" DATE, "signupApproved" INTEGER
    )
  `;
}

function flag(value: boolean | null | undefined): number | null {
  return value === undefined || value === null ? null : value ? 1 : 0;
}

async function seed(db: SQL, users: SeedUser[]): Promise<void> {
  for (const user of users) {
    await db`
      INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt",
                          "role", "banned", "banReason", "signupApproved")
      VALUES (${user.id}, ${user.name}, ${user.email}, ${user.emailVerified ? 1 : 0},
              ${user.createdAt}, ${user.createdAt}, ${user.role ?? null}, ${flag(user.banned)},
              ${user.banned ? "spam" : null}, ${flag(user.signupApproved)})
    `;
  }
}

const at = (minute: number): string => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

const USERS: SeedUser[] = [
  { id: "u1", name: "Ada Admin", email: "ada@example.com", role: "admin", signupApproved: true, createdAt: at(1) },
  { id: "u2", name: "Bob", email: "bob@example.com", role: "user", signupApproved: true, createdAt: at(2) },
  { id: "u3", name: "Cy Banned", email: "cy@example.com", role: "user", banned: true, signupApproved: true, createdAt: at(3) },
  { id: "u4", name: "Di Pending", email: "di@example.com", role: "user", signupApproved: false, createdAt: at(4) },
  { id: "u5", name: "Eve Banned Admin", email: "eve@example.com", role: "admin,user", banned: true, createdAt: at(5) },
  { id: "u6", name: "Fay Legacy", email: "fay@example.com", role: null, banned: null, signupApproved: null, createdAt: at(6) },
];

describe("AdminUsersService", () => {
  let db: SQL;
  let service: AdminUsersService;

  beforeEach(async () => {
    db = new SQL(":memory:");
    await createSchema(db);
    await seed(db, USERS);
    service = new AdminUsersService(db, "sqlite");
  });

  afterEach(async () => {
    await db.close();
  });

  const ids = async (query: AdminUserQuery): Promise<string[]> =>
    (await service.list(query)).items.map((user) => user.id);

  test("pages newest first by default with a total", async () => {
    const page = await service.list({ limit: 2, offset: 2 });
    expect(page.items.map((user) => user.id)).toEqual(["u4", "u3"]);
    expect(page.total).toBe(6);
  });

  test("combines the role and status filters", async () => {
    expect(await ids({ role: "admin", status: "banned" })).toEqual(["u5"]);
    expect(await ids({ role: "admin", status: "active" })).toEqual(["u1"]);
    expect(await ids({ role: "user", status: "pending" })).toEqual(["u4"]);
    expect((await service.list({ role: "user", status: "active" })).total).toBe(1);
  });

  test("treats unset approval and ban flags as an active user", async () => {
    expect(await ids({ status: "active" })).toEqual(["u6", "u2", "u1"]);
    expect(await ids({ status: "banned" })).toEqual(["u5", "u3"]);
    expect(await ids({ status: "pending" })).toEqual(["u4"]);
  });

  test("matches one role in a comma-separated role list", async () => {
    expect(await ids({ role: "user" })).toEqual(["u5", "u4", "u3", "u2"]);
    expect(await ids({ role: "use" })).toEqual([]);
  });

  test("searches email or name case-insensitively with literal wildcards", async () => {
    expect(await ids({ search: "ADA@EXAMPLE", searchField: "email" })).toEqual(["u1"]);
    expect(await ids({ search: "banned", searchField: "name" })).toEqual(["u5", "u3"]);
    expect(await ids({ search: "%", searchField: "name" })).toEqual([]);
    expect(await ids({ search: "banned", searchField: "name", status: "banned", role: "admin" })).toEqual(["u5"]);
  });

  test("sorts by an allowed column with the id as a tiebreaker", async () => {
    expect(await ids({ sortBy: "name", sortDirection: "asc", limit: 3 })).toEqual(["u1", "u2", "u3"]);
    expect(await ids({ sortBy: "email", sortDirection: "desc", limit: 2 })).toEqual(["u6", "u5"]);
  });

  test("returns booleans and ISO dates without exposing other columns", async () => {
    const [pending] = (await service.list({ status: "pending" })).items;
    expect(pending).toEqual({
      id: "u4",
      name: "Di Pending",
      email: "di@example.com",
      role: "user",
      emailVerified: false,
      signupApproved: false,
      banned: false,
      banReason: null,
      banExpires: null,
      createdAt: at(4),
    });
  });
});
