import { describe, expect, it } from "bun:test";
import type { QueryRunner } from "typeorm";
import { getMetadataArgsStorage } from "typeorm";
import { AddVmProviders1792400000000 } from "../migrations/1792400000000-AddVmProviders";
import { HostVm } from "./host-vm.entity";
import { VmProvider } from "./vm-provider.entity";

function recordingRunner(queries: string[]): QueryRunner {
  return {
    query: (sql: string): Promise<unknown[]> => {
      queries.push(sql);
      return Promise.resolve([]);
    },
  } as unknown as QueryRunner;
}

describe("VM provider migration", () => {
  it("[TC-PDVM-006] creates both tables with their checks, keys and the indexes the entities declare", async () => {
    const queries: string[] = [];
    await new AddVmProviders1792400000000().up(recordingRunner(queries));
    const sql = queries.join("\n");

    expect(sql).toContain('CREATE TABLE "vm_providers"');
    expect(sql).toContain('CREATE TABLE "host_vms"');
    expect(sql).toContain(`CHECK ("origin" IN ('created', 'linked'))`);
    expect(sql).toContain('FOREIGN KEY ("hostId") REFERENCES "hosts"("id") ON DELETE CASCADE');
    expect(sql).toContain('FOREIGN KEY ("providerId") REFERENCES "vm_providers"("id") ON DELETE RESTRICT');

    // The desktop SQLite schema comes from the entities, so their index names must be the
    // migration's — a drift here is two schemas that disagree about uniqueness.
    const declared = getMetadataArgsStorage().indices
      .filter((index) => index.target === VmProvider || index.target === HostVm)
      .map((index) => index.name)
      .sort();
    const created = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX "([^"]+)"/g)].map((match) => match[1]).sort();
    expect(declared).toEqual(created);
  });

  it("[TC-PDVM-006] drops the dependent table first", async () => {
    const queries: string[] = [];
    await new AddVmProviders1792400000000().down(recordingRunner(queries));
    expect(queries.map((sql) => sql.trim())).toEqual(['DROP TABLE "host_vms"', 'DROP TABLE "vm_providers"']);
  });
});
