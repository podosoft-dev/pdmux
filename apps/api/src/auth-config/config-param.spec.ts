import { describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { authConfigParam } from "./config-param";

describe("auth config parameters", () => {
  it("binds JSON text that SQLite stores and reads back", async () => {
    const sql = new SQL("sqlite://:memory:");
    await sql`CREATE TABLE "auth_config" ("key" text PRIMARY KEY, "config" text NOT NULL DEFAULT '{}')`;
    const config = { allowDelete: true, hibp: true };

    await sql`INSERT INTO "auth_config" ("key", "config") VALUES (${"server"}, ${authConfigParam("sqlite", config)})`;

    const [row] = await sql<Array<{ config: unknown }>>`SELECT "config" FROM "auth_config"`;
    expect(typeof row?.config).toBe("string");
    expect(JSON.parse(String(row?.config))).toEqual(config);
    await sql.close();
  });

  it("keeps an object for PostgreSQL jsonb", () => {
    const config = { clientId: "id" };
    expect(authConfigParam("postgres", config)).toBe(config);
  });
});
