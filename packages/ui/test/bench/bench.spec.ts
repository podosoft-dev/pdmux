import { expect, test } from '@playwright/test';

/**
 * How long a keystroke takes to appear, with nothing but the browser in the way.
 *
 * ⚠ IT ASSERTS ALMOST NOTHING, AND THAT IS DELIBERATE. A latency threshold on a
 * developer machine fails when somebody else is compiling, and a benchmark that
 * cries wolf gets filtered out of the suite within a month. What this locks is that
 * the harness MEASURED something; the numbers go to stdout for a person to read and
 * to `docs/workspace/` for the record.
 *
 * The one real assertion is the control: a renderer that was asked for has to be the
 * one that ran. A silent fallback to the DOM renderer produces two identical columns
 * and the conclusion "the renderer makes no difference", which is the exact wrong
 * answer and the easiest one to publish.
 */

interface BenchResult {
	renderer: string;
	rendererActive: boolean;
	panes: number;
	rate: number;
	latencies: number[];
	paints: number;
	longTasks: number;
	longestTaskMs: number;
}

/**
 * ⚠ IT CLIMBS PAST WHAT WAS RECORDED, ON PURPOSE. The first run of this bench used
 * the trace at its own pace and found nothing at all — zero long tasks, a 4ms median
 * on the renderer that was supposed to be the culprit. That is a real answer about
 * that load, and the wrong load: one busy agent pane is a few KiB/s, and the report
 * being chased is a screen that has been open for hours with several of them.
 *
 * `rate` compresses the recording's own timing, so it raises the byte rate and the
 * frame rate together — which is what more output actually looks like. The high end
 * is deliberately past anything plausible: a benchmark that never finds the knee
 * cannot say where the knee is.
 */
const MATRIX = [
	{ panes: 1, rate: 1 },
	{ panes: 4, rate: 1 },
	{ panes: 9, rate: 1 },
	{ panes: 9, rate: 4 },
	{ panes: 9, rate: 16 },
	{ panes: 9, rate: 64 },
	{ panes: 9, rate: 256 },
] as const;

const RENDERERS = ['dom', 'webgl'] as const;

/**
 * One glyph per probe, none of which the recorded trace contains.
 *
 * Distinct because the marker stays on screen once painted: reusing one makes every
 * probe after the first find it already there.
 */
const MARKERS = ['⌘', '⌥', '⌃', '⇧', '⎋', '⏏', '✦', '✧', '❖', '⟡', '⟢', '⟣'];

const results: BenchResult[] = [];

for (const renderer of RENDERERS) {
	for (const { panes, rate } of MATRIX) {
		test(`${renderer} · ${panes} pane(s) · ${rate}x`, async ({ page }) => {
			test.setTimeout(180_000);
			await page.goto(`/?panes=${panes}&renderer=${renderer}&rate=${rate}`);
			await page.waitForFunction(
				() => (window as unknown as { __pdmuxBenchReady?: boolean }).__pdmuxBenchReady === true,
			);
			// The load has to be RUNNING before the first probe. Measuring an idle grid
			// answers a question nobody asked.
			await page.waitForTimeout(3_000);

			// Typing goes to the focused pane, and a pane is only focused once clicked —
			// `TerminalPane` guards an unfocused one on purpose.
			await page.locator('.xterm-helper-textarea').first().click({ force: true });

			await page.evaluate(() => {
				const window_ = window as unknown as { __pdmuxLong?: { count: number; worst: number } };
				window_.__pdmuxLong = { count: 0, worst: 0 };
				try {
					new PerformanceObserver((list) => {
						for (const entry of list.getEntries()) {
							window_.__pdmuxLong!.count++;
							window_.__pdmuxLong!.worst = Math.max(window_.__pdmuxLong!.worst, entry.duration);
						}
					}).observe({ entryTypes: ['longtask'] });
				} catch {
					// Not every engine reports them; the latency numbers still stand.
				}
				(window as unknown as { __pdmuxBench: { latencies: number[] } }).__pdmuxBench.latencies.length = 0;
			});

			for (const marker of MARKERS) {
				await page.evaluate((next) => {
					const channel = (window as unknown as { __pdmuxBench: { marker: string; sentAt: number | null } }).__pdmuxBench;
					channel.marker = next;
					channel.sentAt = null;
				}, marker);
				// A real key event through the browser's own input path. A synthetic
				// `InputEvent` never reaches xterm — it reads the textarea, not the event —
				// which is how the first version of this measured nothing at all.
				await page.keyboard.insertText(marker);
				await page.waitForTimeout(1_200);
			}

			const result = await page.evaluate(() => {
				const channel = (window as unknown as { __pdmuxBench: { renderer: string; rendererActive: boolean; paints: unknown[]; latencies: number[] } }).__pdmuxBench;
				const long = (window as unknown as { __pdmuxLong: { count: number; worst: number } }).__pdmuxLong;
				return {
					renderer: channel.renderer,
					rendererActive: channel.rendererActive,
					latencies: channel.latencies,
					paints: channel.paints.length,
					longTasks: long.count,
					longestTaskMs: Math.round(long.worst),
				};
			});

			results.push({ ...result, panes, rate });
			expect(
				result.latencies.length,
				'the harness measured nothing — the probe never reached the terminal',
			).toBeGreaterThan(0);
			if (renderer !== 'dom') {
				expect(result.rendererActive, `${renderer} silently fell back to the DOM renderer`).toBe(true);
			}
		});
	}
}

test.afterAll(() => {
	if (results.length === 0) return;
	const median = (values: number[]): number => {
		if (values.length === 0) return NaN;
		const sorted = [...values].sort((a, b) => a - b);
		return sorted[Math.floor(sorted.length / 2)] ?? NaN;
	};
	const row = (result: BenchResult): string =>
		[
			result.renderer.padEnd(6),
			`${result.panes}p`.padStart(4),
			`${result.rate}x`.padStart(4),
			`${result.latencies.length}`.padStart(5),
			`${Math.round(median(result.latencies))}ms`.padStart(8),
			`${Math.round(Math.max(...result.latencies))}ms`.padStart(8),
			`${result.paints}`.padStart(7),
			`${result.longTasks}`.padStart(6),
			`${result.longestTaskMs}ms`.padStart(8),
		].join(' ');

	console.log('\n=== keystroke -> painted, browser only (no network, no agent) ===');
	console.log(
		['render'.padEnd(6), 'pane'.padStart(4), 'rate'.padStart(4), 'n'.padStart(5), 'median'.padStart(8), 'max'.padStart(8), 'paints'.padStart(7), 'long'.padStart(6), 'worst'.padStart(8)].join(' '),
	);
	for (const result of results) console.log(row(result));
	console.log('');
});
