/** Replaces the server-only driver at desktop build time, before module loading. */
export class AuthPostgresPool {
  constructor() {
    throw new Error("PostgreSQL is unavailable in the desktop runtime; select SQLite");
  }
}
