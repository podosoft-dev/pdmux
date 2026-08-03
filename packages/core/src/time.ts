/**
 * Relative-age helpers shared by the usage gauges and the git feed header.
 *
 * WHY STRUCTURED, NOT A STRING: the original dashboard returned already-translated
 * text ("as of 5 minutes ago"), which made the logic untranslatable by a consumer. Every
 * function here returns the pieces a caller needs to format the sentence itself, so
 * the package never owns a user-facing string.
 */

/** Age of a snapshot, in the unit a UI would actually print. */
export interface RelativeAge {
	/** False when there was no usable timestamp — a UI must then claim nothing. */
	known: boolean;
	ageMs: number;
	/** `now` means "younger than a minute"; the caller usually prints no number. */
	unit: 'now' | 'minute' | 'hour';
	/** Whole minutes or whole hours, matching `unit`. 0 when `unit` is `now`. */
	value: number;
	/** Past the caller's staleness budget — render dimmed rather than as current. */
	stale: boolean;
}

const UNKNOWN: RelativeAge = { known: false, ageMs: 0, unit: 'now', value: 0, stale: false };

/**
 * Bucket an epoch-seconds timestamp against `now` (epoch milliseconds).
 *
 * Bucketing happens on the raw millisecond age, never on rounded minutes: rounding
 * first made a 30-second-old snapshot claim it was "1 minute old", which reads as a
 * collector that is one poll behind when it is in fact current.
 */
export function relativeAge(ts: unknown, now: number, staleMs: number): RelativeAge {
	// An unknown timestamp is reported as `known: false` and NOT as stale: the two
	// callers disagree about what missing means (a missing agent snapshot claims
	// nothing, a missing collector timestamp is a warning), so the verdict is theirs.
	if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return UNKNOWN;
	const ageMs = Math.max(0, now - ts * 1000);
	const minutes = Math.floor(ageMs / 60_000);
	const stale = ageMs > staleMs;
	if (ageMs < 60_000) return { known: true, ageMs, unit: 'now', value: 0, stale };
	if (minutes < 60) return { known: true, ageMs, unit: 'minute', value: minutes, stale };
	return { known: true, ageMs, unit: 'hour', value: Math.round(minutes / 60), stale };
}
