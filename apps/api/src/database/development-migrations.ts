import { join } from "node:path";
import type { AppEnv } from "../config/env.validation";
import type { ReadinessCheck } from "../health/readiness.service";
import { MIGRATIONS_READINESS_CHECK } from "./migration-readiness";

/** Runs `migrate:all` and resolves to its exit status. */
export type MigrateAll = () => Promise<number>;

const API_DIRECTORY = join(__dirname, "../..");

/** Runs the `migrate:all` launcher in the API directory, printing its output with the API's. */
export const runMigrateAll: MigrateAll = async () => {
  const child = Bun.spawn([process.execPath, join(API_DIRECTORY, "scripts/run-migrations.mjs")], {
    cwd: API_DIRECTORY,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
};

export interface DevelopmentMigrationLog {
  info(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface MigrationReadiness {
  register(name: string, check: ReadinessCheck): () => void;
}

export interface DevelopmentMigrationOptions {
  migrateAll?: MigrateAll;
  /** Wait before the first retry; each failure doubles it up to `maxRetryDelayMs`. */
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  /** Ends the retries, for example when the API shuts down. */
  signal?: AbortSignal;
}

export interface DevelopmentMigrations {
  /** True once a run succeeded; false when nothing ran or the retries were stopped. */
  readonly applied: Promise<boolean>;
}

export const DEVELOPMENT_MIGRATION_RETRY_MS = 1_000;
export const DEVELOPMENT_MIGRATION_MAX_RETRY_MS = 10_000;

async function migrateOnce(migrateAll: MigrateAll, log: DevelopmentMigrationLog, attempt: number): Promise<string | null> {
  const started = performance.now();
  let status: number;
  try {
    status = await migrateAll();
  } catch (error) {
    status = -1;
    log.error({ err: error, attempt }, "Start migrate:all failed");
  }
  const durationMs = Math.round(performance.now() - started);
  if (status === 0) {
    log.info(attempt > 1 ? { durationMs, attempt } : { durationMs }, "Applied pending development migrations");
    return null;
  }
  const reason =
    `migrate:all exited with status ${status}; the database may lack migrations this code needs. ` +
    "The API retries it until it succeeds; if the error printed above persists, fix it " +
    "(podo dev exec api bun run --cwd apps/api migrate:all shows it in full)";
  log.error({ status, durationMs, attempt }, `Apply pending development migrations failed: ${reason}`);
  return reason;
}

/** Resolves true after `ms`, or false at once when the signal aborts. The timer keeps no process alive. */
function wait(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Applies pending migrations before a development API starts when
 * PODOKIT_DEV_MIGRATE is true, which `podo dev` sets for the API container.
 * Compose Watch restarts that container whenever a file under apps/api/src
 * changes, so a migration that arrives with a pull or a rebase reaches the
 * development database before the API serves a request that needs it.
 *
 * A failed run does not stop the API. The `migrations` readiness check reports
 * the reason, and the run is retried in the background, waiting longer after
 * each failure, until it succeeds; the check is then removed. A database that
 * was down while the API started is therefore picked up once it is back,
 * without a restart. Resolves after the first run. Never runs in production,
 * where the deployment's migration step owns the schema.
 */
export async function applyDevelopmentMigrations(
  env: Pick<AppEnv, "NODE_ENV" | "PODOKIT_DEV_MIGRATE">,
  readiness: MigrationReadiness,
  log: DevelopmentMigrationLog,
  options: DevelopmentMigrationOptions = {},
): Promise<DevelopmentMigrations> {
  if (!env.PODOKIT_DEV_MIGRATE || env.NODE_ENV === "production") return { applied: Promise.resolve(false) };
  const migrateAll = options.migrateAll ?? runMigrateAll;
  let reason = await migrateOnce(migrateAll, log, 1);
  if (reason === null) return { applied: Promise.resolve(true) };
  const unregister = readiness.register(MIGRATIONS_READINESS_CHECK, async () => {
    throw new Error(reason ?? "Applying pending development migrations");
  });
  const maxDelayMs = options.maxRetryDelayMs ?? DEVELOPMENT_MIGRATION_MAX_RETRY_MS;
  let delayMs = Math.min(options.retryDelayMs ?? DEVELOPMENT_MIGRATION_RETRY_MS, maxDelayMs);
  const applied = (async (): Promise<boolean> => {
    for (let attempt = 2; ; attempt += 1) {
      if (!(await wait(delayMs, options.signal))) return false;
      reason = await migrateOnce(migrateAll, log, attempt);
      if (reason === null) {
        unregister();
        return true;
      }
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  })();
  return { applied };
}
