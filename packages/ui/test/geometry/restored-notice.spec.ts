import { expect, test } from '@playwright/test';

test.describe('[TC-PDTERM-172] the reopened-after-restart notice', () => {
	test.skip(!process.env.PDMUX_BROWSER_TEST, 'set PDMUX_BROWSER_TEST=1 to run browser checks');

	for (const mode of ['split4', 'split9'] as const) {
		test(`wraps inside the pane and leaves the terminal its rows in ${mode}`, async ({ page }, testInfo) => {
			await page.goto(`/?restored&split=${mode}`);
			const pane = page.locator('[data-pdmux-grid] [data-pdmux-pane]:not([hidden])').first();
			const notice = pane.locator('[data-pdmux-restored]');
			await expect(notice).toBeVisible();
			await expect(pane.locator('.xterm-screen')).toBeVisible();
			const geometry = await pane.evaluate((node) => {
				const box = (selector: string): DOMRect => (node.querySelector(selector) as HTMLElement).getBoundingClientRect();
				const text = node.querySelector('[data-pdmux-restored]') as HTMLElement;
				return {
					pane: node.getBoundingClientRect(),
					notice: box('[data-pdmux-restored]'),
					body: box('.pdmux-pane-body'),
					dismiss: box('[data-pdmux-restored-dismiss]'),
					overflow: text.scrollWidth - text.clientWidth,
				};
			});
			// The sentence wraps rather than spilling out of a narrow cell.
			expect(geometry.overflow).toBeLessThanOrEqual(1);
			expect(geometry.notice.right).toBeLessThanOrEqual(geometry.pane.right + 1);
			expect(geometry.dismiss.right).toBeLessThanOrEqual(geometry.pane.right + 1);
			// Above the terminal, not over it, and the terminal keeps most of the pane.
			expect(geometry.body.top).toBeGreaterThanOrEqual(geometry.notice.bottom - 1);
			expect(geometry.body.height).toBeGreaterThan(geometry.pane.height * 0.4);
			await page.screenshot({ path: testInfo.outputPath(`restored-${mode}.png`) });

			await notice.locator('[data-pdmux-restored-dismiss]').click();
			await expect(notice).toHaveCount(0);
			const after = await pane.locator('.pdmux-pane-body').boundingBox();
			expect(after?.height ?? 0).toBeGreaterThan(geometry.body.height);
		});
	}
});
