import { z } from "zod";

// Schema-validated environment. Fails fast at boot if something is wrong.
const schema = z.object({
  NODE_ENV: z.string().default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().default(5002),
  // Bytes one request body may hold; 128 MiB is Bun's default.
  API_MAX_REQUEST_BODY_SIZE: z.coerce.number().int().positive().default(128 * 1024 * 1024),
  CORS_ORIGIN: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  POSTGRES_HOST: z.string().default("localhost"),
  POSTGRES_PORT: z.coerce.number().default(5432),
  POSTGRES_USER: z.string().default("podokit"),
  POSTGRES_PASSWORD: z.string().default("podokit"),
  POSTGRES_DB: z.string().default("podokit"),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30000),
  DB_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  DB_AUTH_POOL_MAX: z.coerce.number().int().positive().default(10),
  READINESS_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(800),
  READINESS_CACHE_MS: z.coerce.number().int().nonnegative().default(2000),
});

export type AppEnv = z.infer<typeof schema>;

export function validateEnv(config: Record<string, unknown>): AppEnv {
  const parsed = schema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${parsed.error.toString()}`);
  }
  return parsed.data;
}
