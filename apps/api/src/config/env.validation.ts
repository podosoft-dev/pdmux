import { z } from "zod";

// Schema-validated environment. Fails fast at boot if something is wrong.
const schema = z.object({
  NODE_ENV: z.string().default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().default(5002),
  // Bytes one request body may hold; 128 MiB is Bun's default.
  API_MAX_REQUEST_BODY_SIZE: z.coerce.number().int().positive().default(128 * 1024 * 1024),
  // Seconds a connection may stay silent, 0 (never closed) to 255. Bun closes idle
  // connections on a 4-second sweep, so 35 outlasts the web proxy's 30-second
  // deadline. An empty value means unset rather than 0.
  API_IDLE_TIMEOUT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(0).max(255).default(35),
  ),
  // Reverse proxies in front of the API whose forwarded header names the client;
  // the generated web proxy is one. 0 uses the socket peer.
  TRUSTED_PROXY_HOPS: z.coerce.number().int().nonnegative().default(0),
  TRUSTED_PROXY_HEADER: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9!#$%&'*+.^_`|~-]+$/, "must be an HTTP header name")
    .default("x-forwarded-for"),
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

// Renamed settings fail loudly: falling back to the default would count and
// record every browser request under the web server's address.
const RENAMED: Record<string, string> = {
  RATE_LIMIT_TRUSTED_PROXY_HOPS: "TRUSTED_PROXY_HOPS",
  RATE_LIMIT_PROXY_HEADER: "TRUSTED_PROXY_HEADER",
};

export function validateEnv(config: Record<string, unknown>): AppEnv {
  for (const [previous, current] of Object.entries(RENAMED)) {
    if (config[previous] !== undefined) {
      throw new Error(`Invalid environment: ${previous} was renamed to ${current}.`);
    }
  }
  const parsed = schema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${parsed.error.toString()}`);
  }
  return parsed.data;
}
