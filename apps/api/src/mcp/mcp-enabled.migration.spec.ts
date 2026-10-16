import { describe, expect, it } from "bun:test";
import type { QueryRunner } from "typeorm";
import { AddMcpEnabledSetting1731300000000 } from "../migrations/1731300000000-AddMcpEnabledSetting";

function runner(queries: string[]): QueryRunner {
  return {
    connection: { options: { type: "postgres" } },
    query: (sql: string): Promise<unknown[]> => {
      queries.push(sql);
      return Promise.resolve([]);
    },
  } as unknown as QueryRunner;
}

describe("MCP setting migration", () => {
  it("preserves the product MCP policy as an opt-out setting", async () => {
    const queries: string[] = [];
    await new AddMcpEnabledSetting1731300000000().up(runner(queries));

    expect(queries.join("\n")).toContain("('mcpEnabled', 'true')");
  });
});
