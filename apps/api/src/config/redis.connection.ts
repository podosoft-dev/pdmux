export interface RedisConnectionOptions {
  host: string;
  port: number;
  db: number;
  username?: string;
  password?: string;
  tls?: Record<string, never>;
  lazyConnect?: boolean;
  enableReadyCheck?: boolean;
  enableOfflineQueue?: boolean;
  maxRetriesPerRequest?: number | null;
  connectTimeout?: number;
  commandTimeout?: number;
}

function integer(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function decoded(value: string, name: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`${name} contains invalid percent encoding`);
  }
}

function fromUrl(value: string): RedisConnectionOptions {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("REDIS_URL must be a valid redis:// or rediss:// URL");
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("REDIS_URL must use the redis:// or rediss:// protocol");
  }
  const dbPath = url.pathname.replace(/^\/+/, "");
  return {
    host: url.hostname || "localhost",
    port: integer("REDIS_URL port", url.port, 6379),
    db: integer("REDIS_URL database", dbPath, 0),
    ...(url.username ? { username: decoded(url.username, "REDIS_URL username") } : {}),
    ...(url.password ? { password: decoded(url.password, "REDIS_URL password") } : {}),
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
  };
}

export function redisConnectionOptions(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<RedisConnectionOptions> = {},
): RedisConnectionOptions {
  const base = env.REDIS_URL
    ? fromUrl(env.REDIS_URL)
    : {
        host: env.REDIS_HOST ?? "localhost",
        port: integer("REDIS_PORT", env.REDIS_PORT, 6379),
        db: integer("REDIS_DB", env.REDIS_DB, 0),
        ...(env.REDIS_USERNAME ? { username: env.REDIS_USERNAME } : {}),
        ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
        ...(env.REDIS_TLS === "true" ? { tls: {} } : {}),
      };
  return { ...base, ...overrides };
}
