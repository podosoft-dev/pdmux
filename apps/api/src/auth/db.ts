import { Pool } from "pg";

// One shared pg connection pool, in its own module so it can be imported by
// auth.ts, the mailer, and the config store without an import cycle (auth.ts
// imports the mailer, which needs the pool for runtime SMTP config).
export const pool = new Pool({
  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER ?? "podokit",
  password: process.env.POSTGRES_PASSWORD ?? "podokit",
  database: process.env.POSTGRES_DB ?? "podokit",
});
