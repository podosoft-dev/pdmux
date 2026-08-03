import { Pool } from "pg";

// The mailer's own pg pool, in its own module so the mailer stays independent of
// any other module. Used only to read the optional admin-configured SMTP settings
// from `auth_config` when the auth module is present; with no such table the read
// fails softly and the mailer falls back to SMTP_* env (see mailer.ts).
export const pool = new Pool({
  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER ?? "podokit",
  password: process.env.POSTGRES_PASSWORD ?? "podokit",
  database: process.env.POSTGRES_DB ?? "podokit",
});
