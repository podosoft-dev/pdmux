export interface RateLimitConfig {
  keyPrefix: string;
  ttlSeconds: number;
  limit: number;
  authTtlSeconds: number;
  authLimit: number;
  runtimeLimit: number;
  storageTimeoutMs: number;
  unavailableRetryAfterSeconds: number;
}

function keyPrefix(value: string | undefined): string {
  const normalized = (value || "podokit:rate-limit").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(normalized)) {
    throw new Error(
      "RATE_LIMIT_KEY_PREFIX must be 1-128 characters using letters, numbers, colons, underscores, or hyphens",
    );
  }
  return normalized;
}

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function rateLimitConfig(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  return {
    keyPrefix: keyPrefix(env.RATE_LIMIT_KEY_PREFIX),
    ttlSeconds: positiveInteger("RATE_LIMIT_TTL", env.RATE_LIMIT_TTL, 60),
    limit: positiveInteger("RATE_LIMIT_MAX", env.RATE_LIMIT_MAX, 300),
    authTtlSeconds: positiveInteger(
      "RATE_LIMIT_AUTH_TTL",
      env.RATE_LIMIT_AUTH_TTL,
      60,
    ),
    authLimit: positiveInteger("RATE_LIMIT_AUTH_MAX", env.RATE_LIMIT_AUTH_MAX, 20),
    runtimeLimit: positiveInteger(
      "RATE_LIMIT_RUNTIME_MAX",
      env.RATE_LIMIT_RUNTIME_MAX,
      1000,
    ),
    storageTimeoutMs: positiveInteger(
      "RATE_LIMIT_STORAGE_TIMEOUT_MS",
      env.RATE_LIMIT_STORAGE_TIMEOUT_MS,
      1000,
    ),
    unavailableRetryAfterSeconds: positiveInteger(
      "RATE_LIMIT_UNAVAILABLE_RETRY_AFTER",
      env.RATE_LIMIT_UNAVAILABLE_RETRY_AFTER,
      1,
    ),
  };
}

// The secret Better Auth signs session cookies with (the auth module trims it the
// same way). Without it, sessions are not recognized and requests are counted by
// client address.
export function sessionSigningSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.BETTER_AUTH_SECRET?.trim() || undefined;
}
