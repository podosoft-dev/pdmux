import type { SQL } from "bun";
import type { ReadinessCheck } from "../health/readiness.service";
import type { MigrationSet } from "./migration-files";

/** Reported down while the database lacks a migration of this build. */
export const MIGRATIONS_READINESS_CHECK = "migrations";

/**
 * Compares the migrations table with the build's list. Once every migration is
 * applied the check stays up without a query: this process never runs one.
 */
export function pendingMigrationsCheck(sql: () => SQL, set: MigrationSet): ReadinessCheck {
  const expected = set.files.flatMap((entry) => entry.name ? [entry.name] : []);
  let applied = expected.length === 0;
  return async (): Promise<void> => {
    if (applied) return;
    const rows = await sql()<Array<{ name: string }>>`SELECT "name" FROM "migrations"`;
    const done = new Set(rows.map((row) => row.name));
    const pending = expected.filter((name) => !done.has(name));
    if (pending.length > 0) {
      throw new Error(`${pending.length} migrations are pending; run migrate:all: ${pending.join(", ")}`);
    }
    applied = true;
  };
}
