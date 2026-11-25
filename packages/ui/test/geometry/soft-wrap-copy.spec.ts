import { expect, test } from '@playwright/test';

/**
 * Rows a native session soft-wrapped must be one line to the viewer's terminal: selecting or
 * triple-clicking them copies the line the program wrote, not pieces. The frame is the
 * engine's own (see soft-wrap.ts); the terminal is the real xterm.js the product ships.
 */
type Row = { text: string; wrapped: boolean };
type SoftWrap = { rows: Row[]; buffer: string; baseY: number; selectRows(from: number, to: number): string; selection(): string };

const long = 'A' + '0123456789'.repeat(7) + 'Z';

test.describe('[TC-PDTERM-189] a native soft wrap copies as one line in xterm.js', () => {
	test.skip(!process.env.PDMUX_BROWSER_TEST, 'set PDMUX_BROWSER_TEST=1 to run browser checks');

	test('the engine frame leaves xterm.js with wrapped rows that select and copy as one line', async ({ page }, testInfo) => {
		await page.goto('/soft-wrap.html');
		await page.waitForFunction(() => 'softWrap' in window);
		const state = await page.evaluate(() => {
			const { rows, buffer, baseY } = (window as unknown as { softWrap: SoftWrap }).softWrap;
			return { rows, buffer, baseY };
		});
		expect(state.buffer).toBe('alternate');
		// Nothing scrolled: the wraps did not push the screen up.
		expect(state.baseY).toBe(0);
		expect(state.rows.map((row) => row.wrapped)).toEqual([false, true, false, true, false, false]);
		expect(state.rows[0]?.text).toBe(('first ' + long).slice(0, 40));

		const select = (from: number, to: number): Promise<string> =>
			page.evaluate(([a, b]) => (window as unknown as { softWrap: SoftWrap }).softWrap.selectRows(a, b), [from, to] as const);
		expect(await select(0, 1)).toBe('first ' + long);
		// A wide character that did not fit left filler, not a space.
		expect(await select(2, 3)).toBe('k'.repeat(39) + '가나다');

		// Triple-click selects the whole wrapped line, from either of its rows.
		const box = await page.locator('.xterm-screen').boundingBox();
		if (!box) throw new Error('no terminal on the page');
		const rowHeight = box.height / state.rows.length;
		await page.mouse.click(box.x + 20, box.y + rowHeight * 1.5, { clickCount: 3 });
		expect(await page.evaluate(() => (window as unknown as { softWrap: SoftWrap }).softWrap.selection())).toBe('first ' + long);
		await page.screenshot({ path: testInfo.outputPath('soft-wrap.png') });
	});
});
