import type { SQL } from "bun";
import { describe, expect, it } from "bun:test";
import { validateEnv } from "../config/env.validation";
import { authConfigStore } from "./auth-config-store";
import { refreshForRequest } from "./auth-provider";
import { configureAuthQueryDatabase } from "./db";

describe("refreshForRequest", () => {
  it("stops waiting for a configuration refresh the database does not answer", async () => {
    let queries = 0;
    // Every query waits forever, like one on a paused server.
    const silent = (): Promise<never> => {
      queries += 1;
      return new Promise(() => undefined);
    };
    const previous = configureAuthQueryDatabase(silent as unknown as SQL);

    const waitMs = validateEnv(process.env).READINESS_CHECK_TIMEOUT_MS;
    const started = Date.now();
    let waited: number;
    try {
      await refreshForRequest();
      waited = Date.now() - started;
    } finally {
      // Later specs in this process must not read settings through the silent
      // database or join the refresh it never answers.
      configureAuthQueryDatabase(previous);
      authConfigStore.invalidate();
    }

    expect(queries).toBeGreaterThan(0);
    expect(waited).toBeGreaterThanOrEqual(waitMs - 10);
    expect(waited).toBeLessThan(waitMs + 500);
  });
});
