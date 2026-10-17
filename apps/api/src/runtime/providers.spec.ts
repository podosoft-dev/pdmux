import { describe, expect, it } from "bun:test";
import { PROVIDERS } from "../config/providers";
import { providersFromEnvironment } from "../config/provider-selection";

// The variables apps/desktop/src/stack-manager.ts gives the API and web processes.
const DESKTOP_ENV = {
  DATABASE_PROVIDER: "sqlite",
  CACHE_PROVIDER: "memory",
  OBJECT_STORAGE_PROVIDER: "local",
  EVENTS_PROVIDER: "memory",
  JOBS_PROVIDER: "local",
};

describe("[TC-PDDESKTOP-001] runtime provider profile", () => {
  it("selects external providers for the server profile", () => {
    expect(providersFromEnvironment(PROVIDERS, {})).toEqual({
      database: "postgres",
      cache: "redis",
      "object-storage": "s3",
      events: "redis",
      jobs: "bullmq",
    });
  });

  it("selects embedded providers for the desktop profile", () => {
    expect(providersFromEnvironment(PROVIDERS, DESKTOP_ENV)).toEqual({
      database: "sqlite",
      cache: "memory",
      "object-storage": "local",
      events: "memory",
      jobs: "local",
    });
  });

  it("allows each capability to be changed independently", () => {
    expect(providersFromEnvironment(PROVIDERS, { CACHE_PROVIDER: "memory" })).toEqual({
      database: "postgres",
      cache: "memory",
      "object-storage": "s3",
      events: "redis",
      jobs: "bullmq",
    });
    expect(() => providersFromEnvironment(PROVIDERS, { JOBS_PROVIDER: "cron" })).toThrow("JOBS_PROVIDER");
  });
});
