import dataSource from "./data-source";

async function migrate(): Promise<void> {
  await dataSource.initialize();
  try {
    await dataSource.runMigrations({ transaction: "all" });
  } finally {
    await dataSource.destroy();
  }
}

void migrate().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Migration failed: ${message}\n`);
  process.exitCode = 1;
});
