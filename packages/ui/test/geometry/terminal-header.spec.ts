import { expect, test } from '@playwright/test';

test.describe('[TC-PDUI-229] terminal header zoom and restore', () => {
	test.skip(!process.env.PDMUX_BROWSER_TEST, 'set PDMUX_BROWSER_TEST=1 to run browser checks');

	// The fixture has six populated slots: one live session and two new slots per host.
	for (const [mode, visible] of [['split2', 2], ['split4', 4], ['split9', 6]] as const) {
		test(`restores ${mode} after two header clicks with body focus pinned`, async ({ page }, testInfo) => {
			await page.goto(`/?body-focus&split=${mode}`);
			const grid = page.locator('[data-pdmux-grid]');
			const panes = grid.locator('[data-pdmux-pane]:not([hidden])');
			await expect(panes).toHaveCount(visible);
			const target = panes.first();
			await expect(target.locator('.xterm-screen')).toBeVisible();
			const originals = await grid.locator('[data-pdmux-pane]').elementHandles();
			const before = await page.locator('[data-harness-layout]').getAttribute('data-harness-layout');
			if (!before) throw new Error('Missing fixture layout');
			const beforeLayout = JSON.parse(before) as { mode: string; slots: unknown[]; page: number; clickAction: string };
			const beforeBox = await target.boundingBox();
			if (!beforeBox) throw new Error('Missing terminal bounds');
			const slotId = await target.getAttribute('data-pdmux-pane');
			const stableTarget = grid.locator(`[data-pdmux-pane="${slotId}"]`);

			// The app pins body clicks to focus; that must not change the layout.
			await target.locator('[data-pdmux-surface]').click();
			await expect(target).toHaveAttribute('data-pdmux-focused', 'true');
			await expect(target).toHaveAttribute('data-pdmux-zoomed', 'false');
			await expect(panes).toHaveCount(visible);
			await page.screenshot({ path: testInfo.outputPath('split-before.png') });

			// Narrow splits can truncate the label; the header padding is still clickable.
			await stableTarget.locator('.pdmux-pane-head').click({ position: { x: 4, y: 4 } });
			await expect(stableTarget).toHaveAttribute('data-pdmux-zoomed', 'true');
			await expect(panes).toHaveCount(1);
			await expect(grid).toHaveAttribute('data-pdmux-mode', mode);
			const expanded = await stableTarget.boundingBox();
			const gridBox = await grid.boundingBox();
			if (!expanded || !gridBox) throw new Error('Missing expanded bounds');
			expect(expanded.width).toBeGreaterThan(beforeBox.width * 1.5);
			expect(Math.abs(expanded.width - gridBox.width)).toBeLessThanOrEqual(2);
			expect(Math.abs(expanded.height - gridBox.height)).toBeLessThanOrEqual(2);
			await page.screenshot({ path: testInfo.outputPath('zoomed.png') });

			await stableTarget.locator('.pdmux-pane-head').click({ position: { x: 4, y: 4 } });
			await expect(stableTarget).toHaveAttribute('data-pdmux-zoomed', 'false');
			await expect(panes).toHaveCount(visible);
			const restored = await stableTarget.boundingBox();
			if (!restored) throw new Error('Missing restored bounds');
			for (const key of ['x', 'y', 'width', 'height'] as const) {
				expect(Math.abs(restored[key] - beforeBox[key]), `restore ${key}`).toBeLessThanOrEqual(2);
			}
			const after = JSON.parse((await page.locator('[data-harness-layout]').getAttribute('data-harness-layout')) ?? '{}') as Record<string, unknown>;
			for (const key of ['mode', 'slots', 'page', 'clickAction'] as const) expect(after[key]).toEqual(beforeLayout[key]);
			for (const original of originals) expect(await original.evaluate((node) => node.isConnected)).toBe(true);
			await page.screenshot({ path: testInfo.outputPath('split-restored.png') });
		});
	}
});
