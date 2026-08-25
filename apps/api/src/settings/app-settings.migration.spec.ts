import { describe, expect, it } from "bun:test";
import type { QueryRunner } from "typeorm";
import { InitAppSettings1720400000000 } from "../migrations/1720400000000-InitAppSettings";
import { AddMcpEnabledSetting1731300000000 } from "../migrations/1731300000000-AddMcpEnabledSetting";

describe("app setting migration", () => {
  it("seeds every authentication feature and policy default", async () => {
    const queries: string[] = [];
    const runner = {
      query: (sql: string): Promise<unknown[]> => {
        queries.push(sql);
        return Promise.resolve([]);
      },
    } as unknown as QueryRunner;

    await new InitAppSettings1720400000000().up(runner);

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

  it("preserves the product MCP policy as an opt-out setting", async () => {
    const queries: string[] = [];
    const runner = {
      query: (sql: string): Promise<unknown[]> => {
        queries.push(sql);
        return Promise.resolve([]);
      },
    } as unknown as QueryRunner;

    await new AddMcpEnabledSetting1731300000000().up(runner);

    expect(queries.join("\n")).toContain("('mcpEnabled', 'true')");
  });
});
