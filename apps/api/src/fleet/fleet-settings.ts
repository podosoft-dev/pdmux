/**
 * Typed view over the `fleet_settings` key/value rows, with the defaults an
 * install runs on before an admin ever opens the settings page.
 *
 * The parsing lives in pure functions so the clamping rules (which exist because
 * a bad value reaches every agent on the fleet) can be unit-tested without a DB.
 */

export interface FleetSettings {
  /** Seconds between agent heartbeats. Matches agentConfigSchema's bounds. */
  heartbeatSec: number;
  /** Seconds between git collection passes on the agent. */
  gitIntervalSec: number;
  /** Roots the agent scans for checkouts. */
  gitRoots: string[];
  /** Commits per repo in the graph window. */
  gitLimit: number;
  /** Max NEW commit details per repo per pass — bounds a cold start. */
  gitDetailBudget: number;
  /** Coding-agent providers whose usage windows the agent reports. */
  usageProviders: string[];
  /** How often the agent re-reads provider usage (far costlier than a heartbeat). */
  usageIntervalSec: number;
  /** Per-service probe timeout — a hung port must not delay the whole heartbeat. */
  probeTimeoutMs: number;
  /** Cap on `git status` entries reported for one repo. */
  statusFileCap: number;
  /** Cap on a stored commit message body. */
  bodyMaxChars: number;
  /** Terminal output buffered per pane (agent side) before oldest bytes are dropped.
   *  The relay uses the same number as its own per-pane budget toward the browser. */
  terminalBufferBytes: number;
  /**
   * Seconds between stored metric samples. Heartbeats arrive every few seconds;
   * storing each one would write ~17k rows per host per day to draw a graph whose
   * pixels are 30s apart.
   */
  metricStepSec: number;
  /** Days of metric history kept before the prune job deletes it. */
  metricRetentionDays: number;
  /**
   * Days a host may stay silent before the sweep DELETES IT. `0` disables the
   * sweep entirely, and that is the default.
   *
   * ⚠ OFF BY DEFAULT, AND IT HAS TO BE. Any non-zero default would, at the moment
   * the upgrade lands, delete every host that was already past the window —
   * machines nobody chose to remove, on the schedule of a migration. And the
   * delete is not recoverable: a host row takes its agent tokens, enrollment
   * codes, services and collected history with it by `ON DELETE CASCADE`, so the
   * machine is refused until somebody re-registers it and re-runs the installer.
   * An operator opts in; nobody is opted in by shipping.
   *
   * ⚠ NOT PUSHED TO AGENTS. Unlike the collector knobs above, this is a
   * server-side retention rule — `buildAgentConfig` lists its fields explicitly,
   * so this one stays out of the agent's config frame by construction.
   */
  staleHostRetentionDays: number;
}

export const FLEET_SETTING_DEFAULTS: FleetSettings = {
  heartbeatSec: 5,
  gitIntervalSec: 120,
  gitRoots: [],
  gitLimit: 300,
  gitDetailBudget: 120,
  usageProviders: ["claude", "codex"],
  // Mirrors of the protocol's own defaults — an install that never touches the
  // settings page must behave exactly like the contract says it does.
  usageIntervalSec: 60,
  probeTimeoutMs: 2000,
  statusFileCap: 300,
  bodyMaxChars: 1200,
  terminalBufferBytes: 262_144,
  metricStepSec: 30,
  metricRetentionDays: 7,
  // 0 = never remove a host automatically. See the field's comment: this is the
  // one default whose other values delete data the operator did not point at.
  staleHostRetentionDays: 0,
};

export const FLEET_SETTING_KEYS = Object.keys(FLEET_SETTING_DEFAULTS) as (keyof FleetSettings)[];

/** Inclusive bounds; a value outside them is clamped, never rejected, because a
 *  stale client sending 0 must not stop the fleet from collecting anything. */
const NUMBER_BOUNDS: Record<string, { min: number; max: number }> = {
  heartbeatSec: { min: 1, max: 3600 },
  gitIntervalSec: { min: 10, max: 86_400 },
  gitLimit: { min: 10, max: 2000 },
  gitDetailBudget: { min: 0, max: 1000 },
  usageIntervalSec: { min: 10, max: 3600 },
  probeTimeoutMs: { min: 100, max: 10_000 },
  statusFileCap: { min: 10, max: 2000 },
  bodyMaxChars: { min: 200, max: 20_000 },
  terminalBufferBytes: { min: 4096, max: 4_000_000 },
  metricStepSec: { min: 5, max: 3600 },
  metricRetentionDays: { min: 1, max: 3650 },
  // ⚠ `min: 0` IS LOAD-BEARING, and it is the only key here where 0 is a value
  // rather than a stale client's mistake: it is the off switch. Clamping it to 1
  // the way `metricRetentionDays` is clamped would turn "never remove a host" into
  // "remove every host silent for a day" — the exact accident this setting is
  // written to make impossible. There is deliberately nothing between 0 and 1
  // either: a window shorter than a day deletes a machine that is rebooting.
  staleHostRetentionDays: { min: 0, max: 3650 },
};

function clampNumber(key: string, value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const bounds = NUMBER_BOUNDS[key];
  const rounded = Math.round(value);
  if (!bounds) return rounded;
  return Math.min(bounds.max, Math.max(bounds.min, rounded));
}

/** Serialize one setting for storage. Lists are JSON so a path with a comma survives. */
export function encodeSetting(_key: keyof FleetSettings, value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map((v) => String(v)));
  return String(value);
}

function decodeList(raw: string, fallback: string[]): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((v) => String(v));
  } catch {
    // Pre-JSON rows (and hand-edited ones) are comma-separated; accept both.
    const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) return parts;
  }
  return fallback;
}

/** Merge stored rows onto the defaults. Unknown keys and unparsable values are ignored. */
export function resolveFleetSettings(rows: { key: string; value: string }[]): FleetSettings {
  const out: FleetSettings = { ...FLEET_SETTING_DEFAULTS, gitRoots: [...FLEET_SETTING_DEFAULTS.gitRoots], usageProviders: [...FLEET_SETTING_DEFAULTS.usageProviders] };
  for (const row of rows) {
    switch (row.key) {
      case "gitRoots":
        out.gitRoots = decodeList(row.value, FLEET_SETTING_DEFAULTS.gitRoots);
        break;
      case "usageProviders":
        out.usageProviders = decodeList(row.value, FLEET_SETTING_DEFAULTS.usageProviders);
        break;
      case "heartbeatSec":
      case "gitIntervalSec":
      case "gitLimit":
      case "gitDetailBudget":
      case "usageIntervalSec":
      case "probeTimeoutMs":
      case "statusFileCap":
      case "bodyMaxChars":
      case "terminalBufferBytes":
      case "metricStepSec":
      case "metricRetentionDays":
      case "staleHostRetentionDays":
        out[row.key] = clampNumber(row.key, Number(row.value), FLEET_SETTING_DEFAULTS[row.key]);
        break;
      default:
        break;
    }
  }
  return out;
}
