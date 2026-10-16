import { describe, expect, it } from "bun:test";
import type { DatabaseProviderName } from "@podosoft/podokit-runtime";
import { PROVIDERS } from "../config/providers";

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
