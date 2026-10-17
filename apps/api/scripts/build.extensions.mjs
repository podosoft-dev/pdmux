import { existsSync } from "node:fs";

// This owned file is never overwritten by `podo update`. List entry points the
// API build bundles next to PodoKit's, such as a maintenance command run from
// the image. Each must exist.
//
// The desktop shell runs desktop-migrate.js instead of migrate.js: pdmux
// migrations are PostgreSQL-only, so its SQLite schema comes from the desktop
// tables and entity synchronization. The entry is listed only where it exists
// because PodoKit's build spec runs this file in fixture layouts without it;
// desktop staging fails when the bundle is missing.
const DESKTOP_MIGRATE = "src/desktop-migrate.ts";

export const appBuildTargets = existsSync(DESKTOP_MIGRATE)
  ? [{ entrypoint: DESKTOP_MIGRATE, outdir: "dist" }]
  : [];
