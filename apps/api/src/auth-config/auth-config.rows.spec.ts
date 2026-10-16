import { afterEach, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import type { QueryRunner } from "typeorm";
import { InitAuthConfig1720500000000 } from "../migrations/1720500000000-InitAuthConfig";
import { readAuthConfigRow, readAuthConfigRows, writeAuthConfigRow } from "./auth-config.rows";

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
  await new InitAuthConfig1720500000000().up(runner);
  return sql;
}

describe("auth config rows on SQLite", () => {
  it("reads the integer enabled column back as a boolean", async () => {
    const sql = await sqliteDatabase();
    await writeAuthConfigRow(sql, "sqlite", { key: "smtp", enabled: true, config: { host: "mail" }, secret: null });
    await writeAuthConfigRow(sql, "sqlite", { key: "social.github", enabled: false, config: {}, secret: null });

    expect(await readAuthConfigRow(sql, "smtp")).toEqual({
      key: "smtp",
      enabled: true,
      config: JSON.stringify({ host: "mail" }),
      secret: null,
    });
    const rows = await readAuthConfigRows(sql);
    expect(rows.map((row) => [row.key, row.enabled])).toEqual([
      ["smtp", true],
      ["social.github", false],
    ]);
    expect(await readAuthConfigRow(sql, "server")).toBeNull();
  });

  it("keeps a boolean through a read and rewrite", async () => {
    const sql = await sqliteDatabase();
    await writeAuthConfigRow(sql, "sqlite", { key: "smtp", enabled: true, config: {}, secret: null });
    const current = await readAuthConfigRow(sql, "smtp");
    if (!current) throw new Error("expected the smtp row");
    await writeAuthConfigRow(sql, "sqlite", { ...current, secret: "sealed" });
    expect((await readAuthConfigRow(sql, "smtp"))?.enabled).toBe(true);
  });
});
