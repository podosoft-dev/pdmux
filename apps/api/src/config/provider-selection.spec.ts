import { describe, expect, it } from "bun:test";
import { CACHE, type ProviderSelections, type ServiceKey } from "@podosoft/podokit-runtime";
import {
  assertSelectedProvidersInstalled,
  providersFromEnvironment,
  selectedFromEnvironment,
} from "./provider-selection";

const generated: ProviderSelections = {
  database: "postgres",
  cache: "redis",
  "object-storage": "s3",
  events: "redis",
  jobs: "bullmq",
};

function registry(keys: symbol[]): { tryResolve<T>(key: ServiceKey<T>): T | undefined } {
  return { tryResolve: <T>(key: ServiceKey<T>) => (keys.includes(key) ? ({} as T) : undefined) };
}

describe("provider selection", () => {
  it("keeps the generated providers without variables", () => {
    expect(providersFromEnvironment(generated, {})).toEqual(generated);
    expect(providersFromEnvironment(generated, { DATABASE_PROVIDER: " " })).toEqual(generated);
  });

  it("replaces a capability whose variable is set", () => {
    const env = { DATABASE_PROVIDER: "SQLite", CACHE_PROVIDER: "memory", JOBS_PROVIDER: "local" };
    expect(providersFromEnvironment(generated, env)).toEqual({
      ...generated,
      database: "sqlite",
      cache: "memory",
      jobs: "local",
    });
    expect(selectedFromEnvironment(env)).toEqual(["database", "cache", "jobs"]);
  });

  it("rejects an unknown provider name", () => {
    expect(() => providersFromEnvironment(generated, { OBJECT_STORAGE_PROVIDER: "gcs" })).toThrow(
      "OBJECT_STORAGE_PROVIDER must be one of s3, local",
    );
  });

  it("fails when a variable selects a provider without its module", () => {
    const env = { CACHE_PROVIDER: "memory", DATABASE_PROVIDER: "sqlite" };
    const providers = providersFromEnvironment(generated, env);
    expect(() => assertSelectedProvidersInstalled(registry([]), providers, env)).toThrow(
      "no installed module provides CACHE_PROVIDER=memory",
    );
    expect(() => assertSelectedProvidersInstalled(registry([CACHE]), providers, env)).not.toThrow();
    expect(() => assertSelectedProvidersInstalled(registry([]), generated, {})).not.toThrow();
  });
});
