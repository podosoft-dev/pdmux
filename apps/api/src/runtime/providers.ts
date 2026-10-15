import { PROVIDER_NAMES, type ProviderCapability, type ProviderSelections } from "@podosoft/podokit-runtime";

function isDesktop(env: NodeJS.ProcessEnv): boolean {
  return env.PDMUX_DESKTOP === "1" || env.PDMUX_DESKTOP === "true";
}

function provider<C extends ProviderCapability>(
  capability: C,
  value: string | undefined,
  fallback: ProviderSelections[C],
  name: string,
): ProviderSelections[C] {
  const allowed: readonly string[] = PROVIDER_NAMES[capability];
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (allowed.includes(normalized)) return normalized as ProviderSelections[C];
  throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
}

/**
 * One build serves both the self-hosted server and the desktop shell, so the
 * providers are chosen from the environment at startup rather than fixed when
 * the project was generated. `config/providers.ts` exposes this selection to the
 * PodoKit modules, which each stay inactive unless their provider is selected.
 */
export function runtimeProviders(env: NodeJS.ProcessEnv = process.env): ProviderSelections {
  const desktop = isDesktop(env);
  return {
    database: provider("database", env.PDMUX_DATABASE_PROVIDER, desktop ? "sqlite" : "postgres", "PDMUX_DATABASE_PROVIDER"),
    cache: provider("cache", env.PDMUX_CACHE_PROVIDER, desktop ? "memory" : "redis", "PDMUX_CACHE_PROVIDER"),
    "object-storage": provider("object-storage", env.PDMUX_OBJECT_STORAGE_PROVIDER, desktop ? "local" : "s3", "PDMUX_OBJECT_STORAGE_PROVIDER"),
    events: provider("events", env.PDMUX_EVENTS_PROVIDER, desktop ? "memory" : "redis", "PDMUX_EVENTS_PROVIDER"),
    jobs: provider("jobs", env.PDMUX_JOBS_PROVIDER, desktop ? "local" : "bullmq", "PDMUX_JOBS_PROVIDER"),
  };
}

export function isDesktopLoopbackUrl(value: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isDesktop(env)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}
