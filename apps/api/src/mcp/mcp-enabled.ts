import { pool } from "../auth/db";

/**
 * Is this pdmux server an MCP server at all?
 *
 * ⚠ IT IS READ THROUGH A POOL QUERY, NOT THROUGH `SettingsService`, and that is the
 * whole reason this file exists. `SettingsService` caches in a `Map` and refreshes
 * only on `onModuleInit` and after its own `setMany()` — so on a deployment with
 * more than one replica, an administrator turning MCP off would turn it off on the
 * one process that handled the PUT and nowhere else, until a restart. A kill switch
 * that works on one replica is not a kill switch.
 *
 * The shape is lifted from `TwoFactorRequiredGuard`, which reads `require2fa` the
 * same way for the same reason: self-contained, so it needs no DI and can be called
 * from the middle of a controller method rather than from a guard.
 *
 * ⚠ IT FAILS OPEN. A database blip must not read as "every coding CLI in the fleet
 * is broken" — the same direction `TwoFactorRequiredGuard` fails, and the same one
 * `auditEnabled()` fails for its own reason. Turning MCP off is a deliberate act; a
 * failed read is not one.
 */
const TTL_MS = 3_000;

/**
 * Not in `FLAG_DEFAULTS`'s union by accident — it is added there so the admin
 * Settings page can toggle it through the existing `PUT /account/settings`. This
 * constant is the fallback used when the read itself fails.
 */
const FALLBACK = true;

let cached = FALLBACK;
let fetchedAt = 0;

export async function mcpEnabled(): Promise<boolean> {
  if (Date.now() - fetchedAt < TTL_MS) return cached;
  try {
    const result = await pool.query<{ value: string }>(
      'SELECT "value" FROM "app_setting" WHERE "key" = $1',
      ["mcpEnabled"],
    );
    // A missing row is a fresh install that predates the seed, not "off".
    cached = result.rows[0] === undefined ? FALLBACK : result.rows[0].value === "true";
  } catch {
    cached = FALLBACK;
  }
  fetchedAt = Date.now();
  return cached;
}

/** For specs: the cache is module state, and a test must not inherit another's. */
export function resetMcpEnabledCache(): void {
  cached = FALLBACK;
  fetchedAt = 0;
}
