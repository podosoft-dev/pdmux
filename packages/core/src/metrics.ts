/**
 * Resource readings and one-hour trend geometry.
 *
 * Two feeds with different cadences meet here: a fast one carrying the current
 * percentages, and a slow ring carrying the trend. Both come from another machine,
 * so every field is treated as untrusted — a malformed feed must yield an empty
 * result, never an exception inside a render loop.
 */

/** At/above this percentage a reading is in the red band. */
export const HOT_PCT = 80;

/**
 * Swap turns red earlier than the others, and both directions of that were
 * measured before the number was picked.
 *
 * 80 is too late. The investigation this row exists for found hosts sitting on
 * 4.2 GB and 5.6 GB of swap while their CPU read 11% — the state a person was
 * reporting as "the terminal is slow", and one that stays black under an 80%
 * rule. But a threshold much below this trains people to ignore the number, the
 * exact failure the agent's own `parseMeminfo` comment records for counting
 * cache as used: a long-uptime box with swappiness=60 parks idle pages in swap
 * and rests in the low tens of per cent with nothing wrong. 50 is above that
 * resting band and below the point where the escape valve is gone.
 */
export const SWAP_HOT_PCT = 50;

/** Sparkline user-space box. Width 120 = one unit per 30s sample of an hour. */
export const SPARK = { w: 120, h: 20 } as const;

export const METRIC_KEYS = ['cpu', 'mem', 'disk', 'swap'] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

/** The fast feed is only trusted while it is this fresh. */
export const METRICS_MAX_AGE_MS = 30_000;

export interface UsageCell {
	/** Rounded 0..100, or null when the probe could not measure. */
	pct: number | null;
	/** Never true for an unknown value: "not measured" must not read as "on fire". */
	hot: boolean;
}

/**
 * One reading of a host card.
 *
 * `null` means the probe could not measure (unreachable or stopped host). A UI
 * renders that as a dash and never as red — and never as 0%, which is a real state.
 */
export function usageCell(value: unknown, hotPct: number = HOT_PCT): UsageCell {
	const pct =
		typeof value === 'number' && Number.isFinite(value)
			? Math.max(0, Math.min(100, Math.round(value)))
			: null;
	return { pct, hot: pct != null && pct >= hotPct };
}

export interface MetricsRow {
	id: string;
	cpuPct?: number | null;
	memPct?: number | null;
	diskPct?: number | null;
	swapPct?: number | null;
}

export interface MetricsFeed {
	/** Epoch seconds the collector wrote this snapshot. */
	ts: number;
	hosts: MetricsRow[];
}

/**
 * Rows from the fast feed — or `null` when it is stale or malformed.
 *
 * A collector can die while its file stays readable, and showing those numbers as
 * live would be a lie: past `maxAgeMs` they are ignored and the slower authoritative
 * feed keeps the cards honest.
 */
export function freshMetrics(feed: unknown, now: number, maxAgeMs = METRICS_MAX_AGE_MS): MetricsRow[] | null {
	if (!feed || typeof feed !== 'object') return null;
	const candidate = feed as { ts?: unknown; hosts?: unknown };
	if (!Number.isFinite(candidate.ts) || !Array.isArray(candidate.hosts)) return null;
	if (now - (candidate.ts as number) * 1000 > maxAgeMs) return null;
	return (candidate.hosts as unknown[]).filter(
		(row): row is MetricsRow => Boolean(row) && typeof (row as MetricsRow).id === 'string',
	);
}

export interface Sample {
	t: number;
	/** null BREAKS the line: an unreachable pass must not be joined across. */
	v: number | null;
}

export type HostSeries = Record<MetricKey, Sample[]>;

export interface HistoryFeed {
	/** Sample timestamps (epoch seconds), one per column of every host's arrays. */
	t: number[];
	/** Window the collector keeps, in seconds. The UI follows it once known. */
	window?: number;
	hosts: Array<{ id: string } & Partial<Record<MetricKey, Array<number | null>>>>;
}

// ⚠ A LITERAL, SO IT DOES NOT FOLLOW METRIC_KEYS BY ITSELF. Adding a key above
// without adding it here leaves `out[key]` undefined and `historySeries` throws
// inside a render loop. The two specs in metrics.test.ts that count the keys are
// what catch it.
const emptySeries = (): HostSeries => ({ cpu: [], mem: [], disk: [], swap: [] });

/**
 * One host's series out of the trend ring.
 *
 * A length mismatch, a junk value or a missing host must yield an empty series
 * rather than invent samples — the arrays are produced by a collector on another
 * machine and a host added mid-window legitimately has a shorter array.
 */
export function historySeries(feed: unknown, hostId: string): HostSeries {
	const out = emptySeries();
	const candidate = (feed && typeof feed === 'object' ? feed : {}) as Partial<HistoryFeed>;
	const stamps = Array.isArray(candidate.t) ? candidate.t : [];
	const row = (Array.isArray(candidate.hosts) ? candidate.hosts : []).find((h) => h?.id === hostId);
	if (!row) return out;
	for (const key of METRIC_KEYS) {
		const values = Array.isArray(row[key]) ? (row[key] as Array<number | null>) : [];
		for (let i = 0; i < Math.min(stamps.length, values.length); i++) {
			const t = stamps[i];
			if (typeof t !== 'number' || !Number.isFinite(t)) continue;
			const v = values[i];
			out[key].push({ t, v: typeof v === 'number' && Number.isFinite(v) ? v : null });
		}
	}
	return out;
}

export interface SparkGeometry {
	/** One path per unbroken run of samples. */
	line: string[];
	/** The same runs closed to the baseline, for the filled area. */
	area: string[];
	/** y of the hot threshold, in user space — also the height of the red band. */
	hotY: number;
	last: number | null;
	max: number | null;
}

export interface SparkOptions {
	/** Epoch SECONDS of the right edge. */
	now?: number;
	/** Drawn window in seconds. */
	window?: number;
	w?: number;
	h?: number;
	hotPct?: number;
}

/**
 * Path geometry for one sparkline.
 *
 * x comes from the sample's TIMESTAMP, not its index: the right edge is always
 * "now", so a dead collector's graph slides left and empties out instead of parking
 * hour-old values under the live edge. y is a fixed 0-100 scale, so the threshold
 * line means the same thing on every card and every metric — auto-scaling turned a
 * 5% wobble into a mountain range.
 *
 * A `null` value BREAKS the line, which is why segments are returned as a list
 * rather than one path: joining across a gap would draw data that was never
 * measured.
 */
export function sparkGeometry(samples: unknown, opts: SparkOptions = {}): SparkGeometry {
	const now = opts.now ?? Date.now() / 1000;
	const window = opts.window ?? 3600;
	const w = opts.w ?? SPARK.w;
	const h = opts.h ?? SPARK.h;
	const hotPct = opts.hotPct ?? HOT_PCT;
	// Rounded: hotY lands in SVG attributes (the band's viewBox), where 3.999999 is noise.
	const hotY = Number((h * (1 - hotPct / 100)).toFixed(2));
	const out: SparkGeometry = { line: [], area: [], hotY, last: null, max: null };
	if (!Array.isArray(samples) || !samples.length) return out;

	type Point = { x: number; y: number; v: number };
	const points: Array<Point | null> = [];
	for (const raw of samples as unknown[]) {
		const sample = (raw && typeof raw === 'object' ? raw : {}) as Partial<Sample>;
		if (typeof sample.t !== 'number' || !Number.isFinite(sample.t)) continue;
		const age = now - sample.t;
		if (age < 0 || age > window) continue; // outside the drawn window
		const x = w - (age / window) * w;
		if (typeof sample.v !== 'number' || Number.isNaN(sample.v)) {
			points.push(null); // gap marker
			continue;
		}
		const v = Math.max(0, Math.min(100, sample.v));
		points.push({ x, y: h - (v / 100) * h, v });
	}

	let run: Point[] = [];
	const flush = (): void => {
		if (!run.length) return;
		// A single sample cannot make a line, so give it a short tick — a fresh feed
		// must show that it has data, not look broken.
		const first = run[0] as Point;
		const drawn = run.length > 1 ? run : [{ ...first, x: Math.max(0, first.x - 1) }, first];
		const d = drawn.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
		out.line.push(d);
		const head = drawn[0] as Point;
		const tail = drawn[drawn.length - 1] as Point;
		out.area.push(`${d} L${tail.x.toFixed(2)} ${h} L${head.x.toFixed(2)} ${h} Z`);
		run = [];
	};
	for (const point of points) {
		if (point) run.push(point);
		else flush();
	}
	flush();

	const values = points.filter((p): p is Point => Boolean(p)).map((p) => p.v);
	if (values.length) {
		out.last = values[values.length - 1] as number;
		out.max = Math.max(...values);
	}
	return out;
}
