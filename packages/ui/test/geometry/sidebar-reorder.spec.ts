import { expect, test } from '@playwright/test';

test.describe('[TC-PDUI-252] reordering the column and the terminal numbers on its cards', () => {
	test.skip(!process.env.PDMUX_BROWSER_TEST, 'set PDMUX_BROWSER_TEST=1 to run browser checks');

	test('the numbers sit on their own row under the name, which keeps the header to itself', async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto('/');
		const cards = page.locator('[data-pdmux-sidebar] > [data-pdmux-host]');
		await expect(cards).toHaveCount(2);
		for (const card of await cards.all()) {
			const geometry = await card.evaluate((node) => {
				const box = (selector: string): DOMRect => (node.querySelector(selector) as HTMLElement).getBoundingClientRect();
				const name = node.querySelector('[data-pdmux-name]') as HTMLElement;
				const panes = node.querySelector('[data-pdmux-panes]') as HTMLElement;
				return {
					card: node.getBoundingClientRect(),
					head: box('.pdmux-card-head'),
					grip: box('[data-pdmux-grip]'),
					name: name.getBoundingClientRect(),
					nameClipped: name.scrollWidth - name.clientWidth,
					nameText: name.textContent,
					panes: panes.getBoundingClientRect(),
					panesOverflow: panes.scrollWidth - panes.clientWidth,
					cog: box('.pdmux-cog'),
				};
			});
			// The header row: grip, name, ⚙ in order and one line tall.
			expect(geometry.grip.right).toBeLessThanOrEqual(geometry.name.left + 1);
			expect(geometry.name.right).toBeLessThanOrEqual(geometry.cog.left + 1);
			expect(geometry.cog.right).toBeLessThanOrEqual(geometry.card.right + 1);
			expect(geometry.head.height).toBeLessThanOrEqual(26);
			// The numbers: below the header, starting under the name, inside the card, never clipped.
			expect(geometry.panes.top).toBeGreaterThanOrEqual(geometry.head.bottom - 1);
			expect(Math.abs(geometry.panes.left - geometry.name.left)).toBeLessThanOrEqual(1);
			expect(geometry.panes.right).toBeLessThanOrEqual(geometry.card.right + 1);
			expect(geometry.panesOverflow).toBeLessThanOrEqual(1);
			// A normal fleet name is not cut once the numbers are off the header (300px column).
			if (geometry.nameText === 'alpha') expect(geometry.nameClipped).toBeLessThanOrEqual(0);
		}
		await page.screenshot({ path: testInfo.outputPath('sidebar-reorder.png'), clip: { x: 0, y: 0, width: 400, height: 500 } });
	});

	test('a name the length of a real dev host is shown whole beside three terminal numbers', async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto('/?names=fleet');
		const name = page.locator('[data-pdmux-host="h1"] [data-pdmux-name]');
		await expect(name).toHaveText('dev-pdindex');
		const clipped = await name.evaluate((node) => node.scrollWidth - node.clientWidth);
		expect(clipped).toBeLessThanOrEqual(0);
	});

	test('dragging a grip moves the card once, on release', async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto('/');
		const order = page.locator('[data-harness-order]');
		await expect(order).toHaveAttribute('data-harness-order', 'h1,h2');
		const grip = page.locator('[data-pdmux-host="h2"] [data-pdmux-grip]');
		const first = await page.locator('[data-pdmux-host="h1"]').boundingBox();
		const start = await grip.boundingBox();
		if (!first || !start) throw new Error('no geometry');
		await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
		await page.mouse.down();
		await page.mouse.move(start.x + start.width / 2, first.y + 4, { steps: 8 });
		// Nothing moves while carried; a line marks the landing place.
		await expect(order).toHaveAttribute('data-harness-order', 'h1,h2');
		await expect(page.locator('[data-pdmux-host="h1"]')).toHaveAttribute('data-pdmux-drop', 'before');
		await page.mouse.up();
		await expect(order).toHaveAttribute('data-harness-order', 'h2,h1');
		await expect(page.locator('[data-pdmux-drop]')).toHaveCount(0);
	});

	test('a terminal number reports its cell', async ({ page }) => {
		await page.goto('/');
		await page.locator('[data-pdmux-host="h2"] button[data-pdmux-pane-jump="3"]').click();
		await expect(page.locator('[data-harness-pane]')).toHaveAttribute('data-harness-pane', '3');
	});
});
