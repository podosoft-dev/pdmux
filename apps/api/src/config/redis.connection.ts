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

export const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 1_000;

/** How long the API waits for Redis to answer one command (`REDIS_COMMAND_TIMEOUT_MS`). */
export function redisCommandTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.REDIS_COMMAND_TIMEOUT_MS;
  if (value === undefined || value === "") return DEFAULT_REDIS_COMMAND_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("REDIS_COMMAND_TIMEOUT_MS must be a positive integer");
  }
  return parsed;
}

export class RedisCommandTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Redis did not answer within ${timeoutMs} ms`);
    this.name = "RedisCommandTimeoutError";
  }
}

/**
 * Rejects with `RedisCommandTimeoutError` when `reply` has not settled within
 * `timeoutMs`, after calling `onTimeout`. Redis answers a connection's commands
 * in order, so a missing reply holds back every later one: `onTimeout` closes
 * the connection, which fails those too and lets its supervisor reconnect.
 */
export async function withReplyTimeout<T>(
  reply: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new RedisCommandTimeoutError(timeoutMs));
      onTimeout();
    }, timeoutMs);
  });
  try {
    return await Promise.race([reply, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the same Redis configuration as BullMQ into a URL for Bun.RedisClient. */
export function redisConnectionUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.REDIS_URL) {
    fromUrl(env.REDIS_URL);
    return env.REDIS_URL;
  }
  const options = redisConnectionOptions(env);
  const url = new URL(`${options.tls ? "rediss" : "redis"}://localhost`);
  url.hostname = options.host;
  url.port = String(options.port);
  url.pathname = `/${options.db}`;
  if (options.username) url.username = options.username;
  if (options.password) url.password = options.password;
  return url.toString();
}
