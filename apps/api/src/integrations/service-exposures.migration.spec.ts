import { describe, expect, it } from "bun:test";
import type { QueryRunner } from "typeorm";
import { AddServiceExposures1731600000000 } from "../migrations/1731600000000-AddServiceExposures";

function recordingRunner(queries: string[]): QueryRunner {
  return {
    query: (sql: string): Promise<unknown[]> => {
      queries.push(sql);
      return Promise.resolve([]);
    },
  } as unknown as QueryRunner;
}

describe("service exposure migration", () => {
  it("[TC-PDEXTERNAL-010] creates provider-neutral ownership layers with HTTP-only exposure constraints", async () => {
    const queries: string[] = [];
    await new AddServiceExposures1731600000000().up(recordingRunner(queries));
    const sql = queries.join("\n");

    expect(sql).toContain('CREATE TABLE "integration_connections"');
    expect(sql).toContain('CREATE TABLE "host_connectors"');
    expect(sql).toContain('CREATE TABLE "service_exposures"');
    expect(sql).toContain('CHECK ("mode" IN (\'access\', \'public\'))');
    expect(sql).toContain('CHECK ("originScheme" IN (\'http\', \'https\'))');
    expect(sql).not.toContain("'tcp'");
    expect(sql).toContain('DEFAULT \'{"cloudflared":false}\'::jsonb');
  });

  it("[TC-PDEXTERNAL-010] drops dependent exposure storage before its parents", async () => {
    const queries: string[] = [];
    await new AddServiceExposures1731600000000().down(recordingRunner(queries));

    expect(queries.map((sql) => sql.trim())).toEqual([
      'DROP TABLE "service_exposures"',
      'DROP TABLE "host_connectors"',
      'DROP TABLE "integration_connections"',
      'ALTER TABLE "hosts" DROP COLUMN "connectorCapabilities"',
    ]);
  });
});
