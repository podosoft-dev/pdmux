import { describe, expect, it } from "bun:test";
import type { QueryRunner } from "typeorm";
import { InitAppSettings1720400000000 } from "../migrations/1720400000000-InitAppSettings";

describe("app setting migration", () => {
  function runner(type: "postgres" | "better-sqlite3", queries: string[]): QueryRunner {
    return {
      connection: { options: { type } },
      query: (sql: string): Promise<unknown[]> => {
        queries.push(sql);
        return Promise.resolve([]);
      },
    } as unknown as QueryRunner;
  }

  it("seeds every authentication feature and policy default", async () => {
    const queries: string[] = [];
    await new InitAppSettings1720400000000().up(runner("postgres", queries));

    const seed = queries.join("\n");
    for (const key of [
      "twoFactor",
      "magicLink",
      "emailOtp",
      "username",
      "multiSession",
      "phoneNumber",
      "apiKey",
      "passkey",
      "organization",
      "oidcProvider",
      "require2fa",
    ]) {
      expect(seed).toContain(`('${key}',`);
    }
  });

  it("uses SQLite-compatible timestamp syntax", async () => {
    const queries: string[] = [];
    await new InitAppSettings1720400000000().up(runner("better-sqlite3", queries));
    expect(queries[0]).toContain("datetime");
    expect(queries[0]).toContain("CURRENT_TIMESTAMP");
    expect(queries[0]).not.toContain("TIMESTAMP WITH TIME ZONE");
  });
});
