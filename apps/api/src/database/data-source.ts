import "dotenv/config";
import { join } from "node:path";
import { DataSource, type DataSourceOptions } from "typeorm";

export const dataSourceOptions: DataSourceOptions = {
  type: "postgres",
  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  username: process.env.POSTGRES_USER ?? "podokit",
  password: process.env.POSTGRES_PASSWORD ?? "podokit",
  database: process.env.POSTGRES_DB ?? "podokit",
  // Entities are auto-discovered by file name (*.entity.ts / .js).
  entities: [join(__dirname, "..", "**", "*.entity{.ts,.js}")],
  migrations: [join(__dirname, "..", "migrations", "*{.ts,.js}")],
  synchronize: false,
};

// Used by the TypeORM CLI for migrations (see package.json scripts).
export default new DataSource(dataSourceOptions);
