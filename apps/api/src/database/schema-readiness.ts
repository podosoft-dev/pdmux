import type { DataSource } from "typeorm";
import { POSTGRES_MIGRATIONS } from "./migrations";

type MigrationSource = Pick<DataSource, "options" | "migrations" | "showMigrations">;

/** The database answered, and its schema is not the one this build expects. */
export class SchemaNotCurrentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaNotCurrentError";
  }
}

/** Never mark a PostgreSQL process ready against a schema older than its code. */
export async function assertMigrationsApplied(source: MigrationSource): Promise<void> {
  if (source.options.type !== "postgres") return;
  if (source.migrations.length !== POSTGRES_MIGRATIONS.length || source.migrations.length === 0) {
    throw new SchemaNotCurrentError("Application migration registry is incomplete");
  }
  if (await source.showMigrations()) {
    throw new SchemaNotCurrentError(
      "Application database has pending migrations; run bun run migrate:all before starting the API or worker",
    );
  }
}

export async function initializeApplicationDataSource(source: DataSource): Promise<void> {
  await source.initialize();
  try {
    await assertMigrationsApplied(source);
  } catch (error: unknown) {
    await source.destroy();
    throw error;
  }
}
