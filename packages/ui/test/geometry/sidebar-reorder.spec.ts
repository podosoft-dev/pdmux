import { expect, test } from '@playwright/test';

test.describe('[TC-PDUI-252] reordering the column and the terminal numbers on its cards', () => {
	test.skip(!process.env.PDMUX_BROWSER_TEST, 'set PDMUX_BROWSER_TEST=1 to run browser checks');

	test('the grip and the numbers fit the header, and the name is what gives way', async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto('/');
		const cards = page.locator('[data-pdmux-sidebar] > [data-pdmux-host]');
		await expect(cards).toHaveCount(2);
		for (const card of await cards.all()) {
			const geometry = await card.evaluate((node) => {
				const head = node.querySelector('.pdmux-card-head') as HTMLElement;
				const box = (selector: string): DOMRect => (node.querySelector(selector) as HTMLElement).getBoundingClientRect();
				return {
					card: node.getBoundingClientRect(),
					head: head.getBoundingClientRect(),
					grip: box('[data-pdmux-grip]'),
					panes: box('[data-pdmux-panes]'),
					cog: box('.pdmux-cog'),
					name: box('[data-pdmux-name]'),
				};
			});
			// (The ⚙ bleeds 6px into the card's padding by design, so the card, not the header row,
			// is the boundary.) Grip, name, numbers and ⚙ in that order, none overlapping.
			expect(geometry.grip.right).toBeLessThanOrEqual(geometry.name.left + 1);
			expect(geometry.name.right).toBeLessThanOrEqual(geometry.panes.left + 1);
			expect(geometry.grip.left).toBeGreaterThanOrEqual(geometry.card.left);
			expect(geometry.cog.right).toBeLessThanOrEqual(geometry.card.right + 1);
			expect(geometry.panes.right).toBeLessThanOrEqual(geometry.cog.left + 1);
			// The header keeps its one-line height with the grip and the numbers in it.
			expect(geometry.head.height).toBeLessThanOrEqual(26);
		}
		await page.screenshot({ path: testInfo.outputPath('sidebar-reorder.png'), clip: { x: 0, y: 0, width: 400, height: 500 } });
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
