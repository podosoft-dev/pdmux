import { describe, expect, it } from "bun:test";
import type { DatabaseProviderName } from "@podosoft/podokit-runtime";
import { Column, Entity, PrimaryColumn } from "typeorm";
import { PROVIDERS } from "../config/providers";
import { APP_ENTITIES } from "./entities";

@Entity("probe_item")
class ProbeItem {
  @PrimaryColumn()
  id!: string;

  @Column()
  count!: number;
}

function databaseProvider(): DatabaseProviderName {
  return PROVIDERS.database;
}

// SQLite applications migrate with the Bun SQLite migrator, not this TypeORM source.
describe.skipIf(databaseProvider() !== "postgres")("migration data source", () => {
  it("runs each migration in its own transaction so one can build indexes concurrently", async () => {
    const { dataSourceOptions } = await import("./data-source.js");
    expect(dataSourceOptions.migrationsTransactionMode).toBe("each");
  });
});

describe("application entities", () => {
  // The TypeORM data source serves PostgreSQL; SQLite migrates without it.
  it.skipIf(databaseProvider() !== "postgres")("loads the entities of the owned entities.ts", async () => {
    const { dataSourceOptions } = await import("./data-source.js");
    expect(dataSourceOptions.entities).toBe(APP_ENTITIES);
  });

  it("compiles TypeORM entity decorators with their design types", () => {
    // TypeORM infers a column's type from this metadata.
    const designType = (Reflect as unknown as {
      getMetadata(key: string, target: object, property: string): unknown;
    }).getMetadata("design:type", ProbeItem.prototype, "count");
    expect(designType).toBe(Number);
  });
});
