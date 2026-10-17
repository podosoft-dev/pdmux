import {
  CACHE,
  EVENTS,
  JOBS,
  OBJECT_STORAGE,
  PROVIDER_CAPABILITIES,
  PROVIDER_NAMES,
  type ProviderCapability,
  type ProviderSelections,
  type ServiceKey,
} from "@podosoft/podokit-runtime";

/** The variable that replaces each capability's generated provider at startup. */
export const PROVIDER_VARIABLES: Readonly<Record<ProviderCapability, string>> = {
  database: "DATABASE_PROVIDER",
  cache: "CACHE_PROVIDER",
  "object-storage": "OBJECT_STORAGE_PROVIDER",
  events: "EVENTS_PROVIDER",
  jobs: "JOBS_PROVIDER",
};

export type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

/** The capabilities whose provider a variable selects, for example in a desktop build. */
export function selectedFromEnvironment(env: ProviderEnvironment = process.env): ProviderCapability[] {
  return PROVIDER_CAPABILITIES.filter((capability) => Boolean(env[PROVIDER_VARIABLES[capability]]?.trim()));
}

/**
 * The generated selection, with a capability replaced when its variable is set,
 * so one build can run, say, PostgreSQL on a server and SQLite in a desktop
 * shell. The selected provider's module must be installed; an unknown name
 * fails at startup.
 */
export function providersFromEnvironment(
  generated: ProviderSelections,
  env: ProviderEnvironment = process.env,
): ProviderSelections {
  const selections: Record<string, string> = { ...generated };
  for (const capability of selectedFromEnvironment(env)) {
    const variable = PROVIDER_VARIABLES[capability];
    const value = env[variable]?.trim().toLowerCase() ?? "";
    const allowed: readonly string[] = PROVIDER_NAMES[capability];
    if (!allowed.includes(value)) {
      throw new Error(`Invalid environment: ${variable} must be one of ${allowed.join(", ")}`);
    }
    selections[capability] = value;
  }
  return selections as unknown as ProviderSelections;
}

// The service each provider module registers when its provider is selected.
// The database has no module: the core service serves PostgreSQL and SQLite.
const PROVIDER_SERVICES: Partial<Record<ProviderCapability, ServiceKey<unknown>>> = {
  cache: CACHE,
  "object-storage": OBJECT_STORAGE,
  events: EVENTS,
  jobs: JOBS,
};

/**
 * Fails startup when a variable selects a provider whose module is not
 * installed, which would otherwise fail the first request that needs it.
 */
export function assertSelectedProvidersInstalled(
  services: { tryResolve<T>(key: ServiceKey<T>): T | undefined },
  providers: ProviderSelections,
  env: ProviderEnvironment = process.env,
): void {
  const missing = selectedFromEnvironment(env).flatMap((capability) => {
    const key = PROVIDER_SERVICES[capability];
    return key && services.tryResolve(key) === undefined
      ? [`${PROVIDER_VARIABLES[capability]}=${providers[capability]}`]
      : [];
  });
  if (missing.length > 0) {
    throw new Error(`Invalid environment: no installed module provides ${missing.join(", ")}`);
  }
}
