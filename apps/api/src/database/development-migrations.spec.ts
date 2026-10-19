import { describe, expect, it } from "bun:test";
import { validateEnv } from "../config/env.validation";
import { ReadinessService } from "../health/readiness.service";
import { applyDevelopmentMigrations, type DevelopmentMigrationLog } from "./development-migrations";

interface Entry {
  level: "info" | "error";
  context: Record<string, unknown>;
  message: string;
}

function recorder(): { log: DevelopmentMigrationLog; entries: Entry[] } {
  const entries: Entry[] = [];
  return {
    entries,
    log: {
      info: (context, message) => entries.push({ level: "info", context, message }),
      error: (context, message) => entries.push({ level: "error", context, message }),
    },
  };
}

describe("development migrations", () => {
  it("reads PODOKIT_DEV_MIGRATE as a boolean that is off unless true", () => {
    expect(validateEnv({}).PODOKIT_DEV_MIGRATE).toBe(false);
    expect(validateEnv({ PODOKIT_DEV_MIGRATE: "" }).PODOKIT_DEV_MIGRATE).toBe(false);
    expect(validateEnv({ PODOKIT_DEV_MIGRATE: "false" }).PODOKIT_DEV_MIGRATE).toBe(false);
    expect(validateEnv({ PODOKIT_DEV_MIGRATE: "true" }).PODOKIT_DEV_MIGRATE).toBe(true);
    expect(() => validateEnv({ PODOKIT_DEV_MIGRATE: "yes" })).toThrow("PODOKIT_DEV_MIGRATE");
  });

  it("runs migrate:all before a development start that podo dev asked for", async () => {
    const { log, entries } = recorder();
    const readiness = new ReadinessService({ cacheMs: 0 });
    let runs = 0;
    const { applied } = await applyDevelopmentMigrations(
      { NODE_ENV: "development", PODOKIT_DEV_MIGRATE: true },
      readiness,
      log,
      {
        migrateAll: async () => {
          runs += 1;
          return 0;
        },
      },
    );
    expect(await applied).toBe(true);
    expect(runs).toBe(1);
    expect(await readiness.run()).toEqual({});
    expect(entries).toEqual([
      { level: "info", context: { durationMs: expect.any(Number) }, message: "Applied pending development migrations" },
    ]);
  });

  it("never runs without the flag or in production", async () => {
    const { log, entries } = recorder();
    const readiness = new ReadinessService({ cacheMs: 0 });
    const migrateAll = async (): Promise<number> => {
      throw new Error("must not run");
    };
    const off = await applyDevelopmentMigrations({ NODE_ENV: "development", PODOKIT_DEV_MIGRATE: false }, readiness, log, { migrateAll });
    const production = await applyDevelopmentMigrations({ NODE_ENV: "production", PODOKIT_DEV_MIGRATE: true }, readiness, log, { migrateAll });
    expect(await off.applied).toBe(false);
    expect(await production.applied).toBe(false);
    expect(await readiness.run()).toEqual({});
    expect(entries).toEqual([]);
  });

  it("starts with the database down and turns ready once it is back and the migrations ran", async () => {
    const { log, entries } = recorder();
    const readiness = new ReadinessService({ cacheMs: 0 });
    const database = { up: false, migrations: [] as string[] };
    let runs = 0;
    const migrateAll = async (): Promise<number> => {
      runs += 1;
      if (!database.up) return 1;
      database.migrations.push("1700000000000-Init");
      return 0;
    };

    const { applied } = await applyDevelopmentMigrations(
      { NODE_ENV: "development", PODOKIT_DEV_MIGRATE: true },
      readiness,
      log,
      { migrateAll, retryDelayMs: 5, maxRetryDelayMs: 20 },
    );
    // The API serves while the database is down, reporting the migrations as not ready.
    expect(await readiness.run()).toEqual({ migrations: "down" });
    await Bun.sleep(40);
    expect(runs).toBeGreaterThan(1);
    expect(await readiness.run()).toEqual({ migrations: "down" });

    database.up = true;
    expect(await applied).toBe(true);
    expect(database.migrations).toEqual(["1700000000000-Init"]);
    expect(await readiness.run()).toEqual({});
    const failures = entries.filter((entry) => entry.level === "error");
    expect(failures.length).toBe(runs - 1);
    expect(failures[0]?.message).toContain("migrate:all exited with status 1");
    expect(failures[0]?.message).toContain("retries it until it succeeds");
    expect(entries.at(-1)).toEqual({
      level: "info",
      context: { durationMs: expect.any(Number), attempt: runs },
      message: "Applied pending development migrations",
    });
  });

  it("waits longer after each failure, up to the limit", async () => {
    const { log } = recorder();
    const readiness = new ReadinessService({ cacheMs: 0 });
    const times: number[] = [];
    const { applied } = await applyDevelopmentMigrations(
      { NODE_ENV: "development", PODOKIT_DEV_MIGRATE: true },
      readiness,
      log,
      {
        migrateAll: async () => {
          times.push(performance.now());
          return times.length < 6 ? 1 : 0;
        },
        retryDelayMs: 10,
        maxRetryDelayMs: 40,
      },
    );
    expect(await applied).toBe(true);
    const gaps = times.slice(1).map((time, index) => time - (times[index] ?? 0));
    // 10, 20, 40, then capped at 40.
    expect(gaps[1]).toBeGreaterThan((gaps[0] ?? 0) * 1.5);
    expect(gaps[2]).toBeGreaterThan(35);
    expect(gaps[4]).toBeLessThan(80);
  });

  it("stops retrying when the API shuts down", async () => {
    const { log } = recorder();
    const readiness = new ReadinessService({ cacheMs: 0 });
    const shutdown = new AbortController();
    let runs = 0;
    const { applied } = await applyDevelopmentMigrations(
      { NODE_ENV: "development", PODOKIT_DEV_MIGRATE: true },
      readiness,
      log,
      {
        migrateAll: async () => {
          runs += 1;
          return 1;
        },
        retryDelayMs: 60_000,
        signal: shutdown.signal,
      },
    );
    shutdown.abort();
    expect(await applied).toBe(false);
    expect(runs).toBe(1);
  });

  it("reports a launcher that cannot start as a failure", async () => {
    const { log, entries } = recorder();
    const readiness = new ReadinessService({ cacheMs: 0 });
    const shutdown = new AbortController();
    await applyDevelopmentMigrations(
      { NODE_ENV: "development", PODOKIT_DEV_MIGRATE: true },
      readiness,
      log,
      {
        migrateAll: async () => {
          throw new Error("spawn failed");
        },
        signal: shutdown.signal,
      },
    );
    shutdown.abort();
    expect(await readiness.run()).toEqual({ migrations: "down" });
    expect(entries.map((entry) => entry.message)).toEqual([
      "Start migrate:all failed",
      expect.stringContaining("Apply pending development migrations failed: migrate:all exited with status -1"),
    ]);
  });
});
