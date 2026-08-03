import { z } from "zod";

// Schema-validated environment. Fails fast at boot if something is wrong.
const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(5002),
  CORS_ORIGIN: z.string().optional(),
  POSTGRES_HOST: z.string().default("localhost"),
  POSTGRES_PORT: z.coerce.number().default(5432),
  POSTGRES_USER: z.string().default("podokit"),
  POSTGRES_PASSWORD: z.string().default("podokit"),
  POSTGRES_DB: z.string().default("podokit"),
});

export type AppEnv = z.infer<typeof schema>;

export function validateEnv(config: Record<string, unknown>): AppEnv {
  const parsed = schema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${parsed.error.toString()}`);
  }
  return parsed.data;
}
