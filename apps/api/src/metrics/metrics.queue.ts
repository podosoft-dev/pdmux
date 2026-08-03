/** Queue shared by the API (which schedules) and the worker (which prunes). */
export const METRICS_QUEUE = "metrics-retention";

/** One repeatable job, hourly. Hourly rather than daily so a long-running install
 *  never accumulates a delete large enough to matter, and the id is fixed so a
 *  restart re-registers the same schedule instead of stacking a second one. */
export const METRICS_PRUNE_JOB = "prune-metric-samples";
export const METRICS_PRUNE_CRON = "17 * * * *";
