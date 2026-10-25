import { expect, test } from '@playwright/test';
import korean from '../../../../apps/web/src/lib/i18n/catalogs/app/ko.json' with { type: 'json' };

test.describe('[TC-PDUI-247] the missing-session notice and its reopen button', () => {
	test.skip(!process.env.PDMUX_BROWSER_TEST, 'set PDMUX_BROWSER_TEST=1 to run browser checks');

	for (const [mode, locale] of [['split4', 'ko'], ['split9', 'ko'], ['split9', '1']] as const) {
		test(`wraps inside the pane, keeps the button whole and hides the reconnecting line in ${mode} (${locale})`, async ({ page }, testInfo) => {
			await page.goto(`/?missing=${locale}&split=${mode}`);
			const pane = page.locator('[data-pdmux-grid] [data-pdmux-pane]:not([hidden])').first();
			const notice = pane.locator('[data-pdmux-missing]');
			await expect(notice).toBeVisible();
			await expect(pane.locator('[data-pdmux-transport]')).toHaveCount(0);
			if (locale === 'ko') await expect(notice.locator('[data-pdmux-missing-reopen]')).toHaveText(korean.pdmux.pane.missingReopen);
			const geometry = await pane.evaluate((node) => {
				const box = (selector: string): DOMRect => (node.querySelector(selector) as HTMLElement).getBoundingClientRect();
				const text = node.querySelector('[data-pdmux-missing]') as HTMLElement;
				const button = node.querySelector('[data-pdmux-missing-reopen]') as HTMLElement;
				return {
					pane: node.getBoundingClientRect(),
					notice: box('[data-pdmux-missing]'),
					body: box('.pdmux-pane-body'),
					button: box('[data-pdmux-missing-reopen]'),
					overflow: text.scrollWidth - text.clientWidth,
					buttonOverflow: button.scrollWidth - button.clientWidth,
				};
			});
			expect(geometry.overflow).toBeLessThanOrEqual(1);
			expect(geometry.buttonOverflow).toBeLessThanOrEqual(1);
			expect(geometry.button.width).toBeGreaterThan(40);
			expect(geometry.button.right).toBeLessThanOrEqual(geometry.pane.right + 1);
			expect(geometry.button.bottom).toBeLessThanOrEqual(geometry.notice.bottom + 1);
			// Above the terminal, not over it, and the terminal keeps a usable part of the pane.
			expect(geometry.body.top).toBeGreaterThanOrEqual(geometry.notice.bottom - 1);
			expect(geometry.body.height).toBeGreaterThan(geometry.pane.height * 0.25);
			await page.screenshot({ path: testInfo.outputPath(`missing-${mode}-${locale}.png`) });

			await notice.locator('[data-pdmux-missing-reopen]').click();
			await expect(pane.locator('[data-pdmux-missing]')).toHaveCount(0);
		});
	}
});
