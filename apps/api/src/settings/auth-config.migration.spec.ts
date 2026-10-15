import { describe, expect, it } from "bun:test";
import type { QueryRunner } from "typeorm";
import { InitAuthConfig1720500000000 } from "../migrations/1720500000000-InitAuthConfig";

function runner(type: "postgres" | "better-sqlite3", queries: string[]): QueryRunner {
  return {
    connection: { options: { type } },
    query: (sql: string): Promise<unknown[]> => {
      queries.push(sql);
      return Promise.resolve([]);
    },
  } as unknown as QueryRunner;
}

describe("auth config migration", () => {
  it("retains PostgreSQL boolean and JSONB columns", async () => {
    const queries: string[] = [];
    await new InitAuthConfig1720500000000().up(runner("postgres", queries));
    expect(queries[0]).toContain("boolean NOT NULL DEFAULT false");
    expect(queries[0]).toContain("jsonb NOT NULL");
  });

  it("uses SQLite integer booleans and JSON text", async () => {
    const queries: string[] = [];
    await new InitAuthConfig1720500000000().up(runner("better-sqlite3", queries));
    expect(queries[0]).toContain("integer NOT NULL DEFAULT 0");
    expect(queries[0]).toContain("text NOT NULL DEFAULT '{}'");
    expect(queries[0]).toContain("DEFAULT CURRENT_TIMESTAMP");
  });
});
