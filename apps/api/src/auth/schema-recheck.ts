/** The shortest time between two rebuilds while Better Auth reports a schema mismatch. */
export const SCHEMA_RECHECK_INTERVAL_MS = 2_000;

export interface SchemaCheckedAuth {
  $context: Promise<{ checkSchema?: (() => Promise<void> | undefined) | undefined }>;
}

export interface SchemaRecheckOptions {
  intervalMs?: number;
  now?: () => number;
}

export function isSchemaMismatch(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "SCHEMA_MISMATCH";
}

/**
 * Better Auth keeps a schema mismatch it found until a migration run by the
 * same process clears it. An API that started before `migrate:all` ran in
 * another process, such as a separate container, therefore failed every
 * sign-in until it restarted. The returned function calls `rebuild` when
 * `auth` holds a mismatch, at most once per interval; the new instance checks
 * the database again, so the first request after the migration succeeds.
 */
export function createSchemaRecheck(
  options: SchemaRecheckOptions = {},
): (auth: SchemaCheckedAuth, rebuild: () => void) => Promise<void> {
  const intervalMs = options.intervalMs ?? SCHEMA_RECHECK_INTERVAL_MS;
  const now = options.now ?? Date.now;
  let rebuiltAt = Number.NEGATIVE_INFINITY;
  return async (auth, rebuild) => {
    // Nothing is pending once the schema is known to be clean.
    const pending = (await auth.$context).checkSchema?.();
    if (!pending) return;
    try {
      await pending;
    } catch (error) {
      // A failure to reach the database is not kept, so only a mismatch needs a rebuild.
      if (!isSchemaMismatch(error) || now() - rebuiltAt < intervalMs) return;
      rebuiltAt = now();
      rebuild();
    }
  };
}
