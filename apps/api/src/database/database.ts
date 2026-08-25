import { SQL } from "bun";
import type { AppEnv } from "../config/env.validation";

export function databaseUrl(env: AppEnv): string {
  const username = encodeURIComponent(env.POSTGRES_USER);
  const password = encodeURIComponent(env.POSTGRES_PASSWORD);
  const database = encodeURIComponent(env.POSTGRES_DB);
  return `postgres://${username}:${password}@${env.POSTGRES_HOST}:${env.POSTGRES_PORT}/${database}`;
}

export class Database {
  readonly sql: SQL;

  constructor(env: AppEnv) {
    this.sql = new SQL(databaseUrl(env), { max: 20 });
  }

  async ping(): Promise<void> {
    await this.sql`SELECT 1`;
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}
