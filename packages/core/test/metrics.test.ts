/**
 * Resource readings and sparkline geometry. The rules under test are the ones that
 * keep a broken collector from looking healthy.
 */
import { describe, expect, it } from 'vitest';
import {
	HOT_PCT,
	METRIC_KEYS,
	SPARK,
	SWAP_HOT_PCT,
	freshMetrics,
	historySeries,
	sparkGeometry,
	usageCell,
} from '../src/index.js';

/** Samples ending "now", `step` seconds apart. */
const series = (values: Array<number | null>, { now = 10_000, step = 30 } = {}): Array<{ t: number; v: number | null }> =>
	values.map((v, i) => ({ t: now - (values.length - 1 - i) * step, v }));

const xsOf = (path: string): number[] => [...path.matchAll(/[ML]([\d.]+) /g)].map((m) => Number(m[1]));
const ysOf = (path: string): number[] => [...path.matchAll(/[ML][\d.]+ ([\d.-]+)/g)].map((m) => Number(m[1]));

describe('[TC-PDCORE-035] a reading is red at the threshold and a dash when unmeasured', () => {
	it('rounds, clamps and never marks an unknown value hot', () => {
		expect(HOT_PCT).toBe(80);
		expect(usageCell(80)).toEqual({ pct: 80, hot: true }); // the boundary IS hot
		expect(usageCell(79)).toEqual({ pct: 79, hot: false });
		expect(usageCell(100)).toEqual({ pct: 100, hot: true });
		expect(usageCell(0)).toEqual({ pct: 0, hot: false }); // 0% is a value, not unknown
		for (const junk of [null, undefined, 'x', Number.NaN, true, {}]) {
			expect(usageCell(junk)).toEqual({ pct: null, hot: false });
		}
		expect(usageCell(41.6).pct).toBe(42);
		expect(usageCell(140).pct).toBe(100);
		expect(usageCell(-5).pct).toBe(0);
	});
});

describe('[TC-PDCORE-095] swap crosses into the red band earlier than the other metrics', () => {
	it('takes a per-metric threshold without moving the default', () => {
		expect(SWAP_HOT_PCT).toBe(50);
		// The state the row exists to catch: hosts sitting on 4.2GB and 5.6GB of swap
		// while their CPU read 11%. Under the shared 80% rule this stays black.
		expect(usageCell(60, SWAP_HOT_PCT)).toEqual({ pct: 60, hot: true });
		expect(usageCell(60)).toEqual({ pct: 60, hot: false });
		expect(usageCell(50, SWAP_HOT_PCT).hot).toBe(true); // the boundary IS hot
		expect(usageCell(49, SWAP_HOT_PCT).hot).toBe(false);
		// A swapless host reports a real 0, and 0 is never hot at any threshold.
		expect(usageCell(0, SWAP_HOT_PCT)).toEqual({ pct: 0, hot: false });
		// Unmeasured stays unmeasured — a threshold cannot conjure a value.
		expect(usageCell(null, SWAP_HOT_PCT)).toEqual({ pct: null, hot: false });
	});

	it('moves the sparkline band with the number, so the two agree', () => {
		// The guide line is drawn from the same threshold the value is coloured by;
		// if they disagreed, a row would read red against a band it never crossed.
		const samples = series([10, 60]);
		expect(sparkGeometry(samples, { now: 10_000, hotPct: SWAP_HOT_PCT }).hotY).toBe(SPARK.h * 0.5);
		expect(sparkGeometry(samples, { now: 10_000 }).hotY).toBe(SPARK.h * 0.2);
	});
});

describe('[TC-PDCORE-036] a stale fast feed is ignored', () => {
	it('accepts a recent feed and rejects a stale or malformed one', () => {
		// The collector can die while its file stays readable; showing those numbers
		// as live would be a lie.
		const now = 1_800_000_000_000;
		const rows = [{ id: 'h1', cpuPct: 9, memPct: 41, diskPct: 75 }];
		const feed = (tsSec: number): unknown => ({ ts: tsSec, hosts: rows });

		expect(freshMetrics(feed(now / 1000), now)).toEqual(rows);
		expect(freshMetrics(feed(now / 1000 - 25), now)).toEqual(rows);
		expect(freshMetrics(feed(now / 1000 - 31), now)).toBeNull();
		expect(freshMetrics(feed(now / 1000 - 9), now, 8_000)).toBeNull();
		for (const bad of [null, undefined, {}, { ts: 'x', hosts: rows }, { ts: now / 1000, hosts: 'nope' }, 'x', 42]) {
			expect(freshMetrics(bad, now)).toBeNull();
		}
		expect(freshMetrics({ ts: now / 1000, hosts: [] }, now)).toEqual([]);
		expect(freshMetrics({ ts: now / 1000, hosts: [{ cpuPct: 5 }, { id: 'ok', cpuPct: 5 }] }, now)).toEqual([
			{ id: 'ok', cpuPct: 5 },
		]);
	});
});

describe('[TC-PDCORE-037] the trend ring survives whatever a collector produced', () => {
	it('pairs only up to the shorter array and skips junk timestamps', () => {
		const feed = {
			t: [1, 2, 3],
			hosts: [
				{ id: 'h1', cpu: [10, null, 30], mem: [1, 2, 3], disk: [4, 5, 6], swap: [7, 8, 9] },
				// A host added mid-window legitimately has shorter arrays. This one also
				// sends no `swap` at all, which is what a collector older than the field
				// looks like: an EMPTY series, never a run of zeros.
				{ id: 'short', cpu: [7], mem: [], disk: [1, 2, 3, 4, 5] },
			],
		};
		const first = historySeries(feed, 'h1');
		expect(first.cpu).toEqual([
			{ t: 1, v: 10 },
			{ t: 2, v: null },
			{ t: 3, v: 30 },
		]);
		expect(METRIC_KEYS.map((k) => first[k].length)).toEqual([3, 3, 3, 3]);

		const short = historySeries(feed, 'short');
		expect(short.cpu).toEqual([{ t: 1, v: 7 }]);
		expect(short.mem).toEqual([]);
		expect(short.disk).toHaveLength(3); // never longer than t
		// An absent key is an absent series, not zeros: a collector too old to send
		// swap must draw no line rather than a flat one along the bottom.
		expect(short.swap).toEqual([]);

		for (const [input, id] of [
			[feed, 'nope'],
			[null, 'h1'],
			[{}, 'h1'],
			[{ t: 'x', hosts: 'y' }, 'h1'],
			[{ t: [1], hosts: [{ id: 'h1', cpu: 'nope' }] }, 'h1'],
		] as const) {
			const out = historySeries(input, id);
			expect(METRIC_KEYS.map((k) => out[k])).toEqual([[], [], [], []]);
		}
		const bad = historySeries({ t: [1, 'x', 3], hosts: [{ id: 'm', cpu: [1, 2, 3] }] }, 'm');
		expect(bad.cpu).toEqual([
			{ t: 1, v: 1 },
			{ t: 3, v: 3 },
		]);
	});
});

describe('[TC-PDCORE-038] x comes from the timestamp, so a dead collector slides left', () => {
	it('puts the newest sample on the right edge and drops out-of-window samples', () => {
		const now = 10_000;
		const geometry = sparkGeometry(series([10, 20, 30], { now }), { now, window: 3600 });
		const xs = xsOf(geometry.line[0] as string);
		expect(xs).toHaveLength(3);
		expect(xs.at(-1)).toBe(SPARK.w);
		expect(xs[0]! < xs[1]!).toBe(true);
		expect(Number((xs[2]! - xs[1]!).toFixed(2))).toBe(Number((SPARK.w / 120).toFixed(2)));

		// An hour-old value must not be parked under the "now" edge.
		const stale = sparkGeometry(
			[
				{ t: now - 7200, v: 90 },
				{ t: now - 10, v: 5 },
			],
			{ now, window: 3600 },
		);
		expect(xsOf(stale.line.join(' ')).some((x) => x < 0)).toBe(false);
		expect(stale.max).toBe(5);
		expect(sparkGeometry([{ t: now - 7200, v: 90 }], { now, window: 3600 }).line).toEqual([]);

		// y is a FIXED 0-100 scale, comparable across cards, 100% at the top.
		const full = sparkGeometry(series([0, 100], { now }), { now, window: 3600 });
		expect(ysOf(full.line[0] as string)).toEqual([SPARK.h, 0]);
	});
});

describe('[TC-PDCORE-039] a null breaks the line and a single sample still draws', () => {
	it('emits one segment per run, closes each area and clamps values', () => {
		const now = 10_000;
		const gap = sparkGeometry(series([10, 20, null, 40, 50], { now }), { now, window: 3600 });
		expect(gap.line).toHaveLength(2);
		expect(gap.area).toHaveLength(2);
		expect(gap.area.every((d) => d.endsWith('Z'))).toBe(true);
		expect(gap.last).toBe(50);

		const one = sparkGeometry(series([42], { now }), { now, window: 3600 });
		expect(one.line).toHaveLength(1);
		expect((one.line[0] as string).match(/[ML]/g)).toHaveLength(2); // a short tick

		for (const input of [[], null, undefined, 'nope', [{ v: 5 }], [{ t: 'x', v: 5 }]]) {
			expect(sparkGeometry(input, { now, window: 3600 }).line).toEqual([]);
		}

		const clamped = sparkGeometry(series([-20, 150], { now }), { now, window: 3600 });
		expect(ysOf(clamped.line[0] as string)).toEqual([SPARK.h, 0]);
		expect(clamped.max).toBe(100); // 150% is a broken probe, not a reading
	});
});

describe('[TC-PDCORE-040] the red band starts at the same threshold as the number', () => {
	it('puts exactly 80% inside the band and 79% below it', () => {
		const now = 10_000;
		const base = sparkGeometry(series([50], { now }), { now, window: 3600 });
		expect(base.hotY).toBe(SPARK.h * 0.2);
		expect(base.hotY).toBe(Number(base.hotY.toFixed(2))); // it lands in an SVG attribute
		const at80 = ysOf(sparkGeometry(series([80], { now }), { now, window: 3600 }).line[0] as string)[0] as number;
		const at79 = ysOf(sparkGeometry(series([79], { now }), { now, window: 3600 }).line[0] as string)[0] as number;
		expect(at80).toBeLessThanOrEqual(base.hotY + 0.001);
		expect(at79).toBeGreaterThan(base.hotY);
	});
});
