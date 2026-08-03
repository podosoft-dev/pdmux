/**
 * The arithmetic behind automatic host removal, kept pure so the one decision
 * that deletes data can be tested without a database.
 *
 * ⚠ THE OFF SWITCH IS A RETURN VALUE, NOT A CALLER'S `if`. `staleCutoff` answers
 * `null` for a disabled window, so a caller that forgets to check gets a type
 * error instead of a cutoff of "now" — which would sweep the entire fleet.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The instant a host must have reported after, to survive this sweep.
 *
 * `null` means the sweep is off for this scope (`retentionDays <= 0`, the
 * shipped default). Anything else is `now - retentionDays`, and a host whose
 * `lastSeenAt` is strictly older than it is due for removal.
 */
export function staleCutoff(now: Date, retentionDays: number): Date | null {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return null;
  return new Date(now.getTime() - Math.round(retentionDays) * DAY_MS);
}
