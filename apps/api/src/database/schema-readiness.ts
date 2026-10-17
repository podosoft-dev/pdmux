import type { DataSource } from "typeorm";
import { assertMigrationsLoaded, migrationSet, type MigrationSet } from "./migration-files";

type MigrationSource = Pick<DataSource, "options" | "migrations" | "showMigrations">;

/** The database answered, and its schema is not the one this build expects. */
export class SchemaNotCurrentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaNotCurrentError";
  }
}

let buildMigrations: MigrationSet | undefined;

/** Never mark a PostgreSQL process ready against a schema older than its code. */
export async function assertMigrationsApplied(
  source: MigrationSource,
  migrations?: MigrationSet,
): Promise<void> {
  if (source.options.type !== "postgres") return;
  migrations ??= buildMigrations ??= migrationSet();
  if (migrations.files.length === 0) {
    throw new SchemaNotCurrentError("Application migration list is empty");
  }
  try {
    assertMigrationsLoaded(source.migrations, migrations);
  } catch (error: unknown) {
    throw new SchemaNotCurrentError(error instanceof Error ? error.message : String(error));
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
