import dataSource from "./data-source";
import { assertMigrationsApplied } from "./schema-readiness";
import { POSTGRES_MIGRATIONS } from "./migrations";

async function migrate(): Promise<void> {
  await dataSource.initialize();
  try {
    await dataSource.runMigrations({ transaction: "all" });
    await assertMigrationsApplied(dataSource);
  } finally {
    await dataSource.destroy();
  }
}

if (process.argv.includes("--list")) {
  // This path is database-free so release checks can inspect the final image.
  process.stdout.write(`${JSON.stringify(POSTGRES_MIGRATIONS.map((Migration) => new Migration().name))}\n`);
} else {
  void migrate().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Migration failed: ${message}\n`);
    process.exitCode = 1;
  });
}
