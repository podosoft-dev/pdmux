/** Queue shared by the API (which schedules) and the worker (which deletes). */
export const STALE_HOSTS_QUEUE = "stale-hosts";

/**
 * One repeatable job, daily.
 *
 * DAILY, NOT HOURLY like the metric prune, because the two jobs answer different
 * questions. A prune that runs late leaves rows on disk; this one DELETES HOSTS,
 * and the shortest window an operator can choose is a day — so running it more
 * often only narrows the gap between "past the window" and "gone", which is the
 * gap the list's own warning lives in. The id is fixed so a restart re-registers
 * the same schedule instead of stacking a second one.
 */
export const STALE_HOSTS_JOB = "remove-stale-hosts";
export const STALE_HOSTS_CRON = "43 4 * * *";
