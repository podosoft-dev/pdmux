import { readdirSync } from "node:fs";
import { POSTGRES_MIGRATIONS } from "../src/database/migrations.ts";

/** A new migration must be registered before any image or desktop bundle is built. */
export function checkMigrations(files = readdirSync(new URL("../src/migrations", import.meta.url))) {
  const names = files
    .filter((file) => /^\d+-.+\.ts$/.test(file))
    .map((file) => {
      const match = /^(\d+)-(.+)\.ts$/.exec(file);
      return `${match[2]}${match[1]}`;
    })
    .sort();
  const registered = POSTGRES_MIGRATIONS.map((Migration) => new Migration().name).sort();
  if (names.length === 0 || JSON.stringify(names) !== JSON.stringify(registered)) {
    throw new Error("Migration registry must contain every source migration exactly once");
  }
}

if (import.meta.main) checkMigrations();
