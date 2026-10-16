// Servers validate Better Auth's database schema at startup and bound every auth
// query with DB_QUERY_TIMEOUT_MS. Maintenance commands, such as the migration
// runner and the admin bootstrap, build the same instance before the schema they
// change exists or matches, and may run statements for longer, so they opt out
// for their process.
let maintenance = false;

export function startMaintenanceCommand(): void {
  maintenance = true;
}

export function isMaintenanceCommand(): boolean {
  return maintenance;
}
