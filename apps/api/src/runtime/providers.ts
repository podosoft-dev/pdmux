export type DatabaseProvider = "postgres" | "sqlite";
export type CacheProvider = "redis" | "memory";
export type ObjectStorageProvider = "s3" | "local";
export type EventsProvider = "redis" | "memory";
export type JobsProvider = "bullmq" | "local";

export interface RuntimeProviders {
  database: DatabaseProvider;
  cache: CacheProvider;
  objectStorage: ObjectStorageProvider;
  events: EventsProvider;
  jobs: JobsProvider;
}

function provider<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
  name: string,
): T {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (allowed.includes(normalized as T)) return normalized as T;
  throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
}

export function runtimeProviders(env: NodeJS.ProcessEnv = process.env): RuntimeProviders {
  const desktop = env.PDMUX_DESKTOP === "1" || env.PDMUX_DESKTOP === "true";
  return {
    database: provider(env.PDMUX_DATABASE_PROVIDER, ["postgres", "sqlite"], desktop ? "sqlite" : "postgres", "PDMUX_DATABASE_PROVIDER"),
    cache: provider(env.PDMUX_CACHE_PROVIDER, ["redis", "memory"], desktop ? "memory" : "redis", "PDMUX_CACHE_PROVIDER"),
    objectStorage: provider(env.PDMUX_OBJECT_STORAGE_PROVIDER, ["s3", "local"], desktop ? "local" : "s3", "PDMUX_OBJECT_STORAGE_PROVIDER"),
    events: provider(env.PDMUX_EVENTS_PROVIDER ?? env.SSE_TRANSPORT, ["redis", "memory"], desktop ? "memory" : "redis", "PDMUX_EVENTS_PROVIDER"),
    jobs: provider(env.PDMUX_JOBS_PROVIDER, ["bullmq", "local"], desktop ? "local" : "bullmq", "PDMUX_JOBS_PROVIDER"),
  };
}

export function isDesktopLoopbackUrl(value: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!(env.PDMUX_DESKTOP === "1" || env.PDMUX_DESKTOP === "true")) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}
