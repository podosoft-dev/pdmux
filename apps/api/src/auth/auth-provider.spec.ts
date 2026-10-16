import type { SQL } from "bun";
import { describe, expect, it } from "bun:test";
import { validateEnv } from "../config/env.validation";
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
    configureAuthQueryDatabase(silent as unknown as SQL);

    const waitMs = validateEnv(process.env).READINESS_CHECK_TIMEOUT_MS;
    const started = Date.now();
    await refreshForRequest();
    const waited = Date.now() - started;

    expect(queries).toBeGreaterThan(0);
    expect(waited).toBeGreaterThanOrEqual(waitMs - 10);
    expect(waited).toBeLessThan(waitMs + 500);
  });
});
