/**
 * Geometry guard — the checks a DOM assertion is structurally blind to.
 *
 * THE BUG THIS LOCKS DOWN: a mount host with no CSS rule of its own broke the flex
 * chain, every box grew to its content height, the commit list never became a scroll
 * container and the detail panel rendered ~7,300px below a viewport that clips
 * overflow. Clicking a commit therefore "did nothing" — and three rounds of fixes
 * missed it, because every verification queried the DOM, where the content was
 * always present. What was missing was its POSITION ON SCREEN.
 *
 * OPT-IN: needs a browser binary. Run `bun run --cwd packages/ui test:geometry`
 * (which sets PDMUX_BROWSER_TEST=1); without the flag these skip and no server runs.
 */
import { expect, test } from '@playwright/test';
import {
	FS_CHECK_W,
	FS_COLUMN_DEFAULTS,
	FS_ROW_CHROME,
	FS_ROW_GAP,
	fsColumnRoom,
	visibleFsColumns,
} from '@pdmux/core';

const enabled = Boolean(process.env.PDMUX_BROWSER_TEST);

test.describe('pdmux ui geometry', () => {
	test.skip(!enabled, 'set PDMUX_BROWSER_TEST=1 to run the browser geometry checks');

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await page.waitForSelector('[data-pdmux-grid]');
	});

	test('[TC-PDUI-040] the shell fills the viewport and the page itself never scrolls', async ({ page }) => {
		const box = await page.evaluate(() => {
			const shell = document.querySelector('.pdmux-shell') as HTMLElement;
			const rect = shell.getBoundingClientRect();
			return {
				height: rect.height,
				viewport: window.innerHeight,
				pageScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
				sidebarScrolls: (() => {
					const side = document.querySelector('[data-pdmux-sidebar]') as HTMLElement;
					return { own: side.scrollHeight > side.clientHeight, overflow: getComputedStyle(side).overflowY };
				})(),
			};
		});
		// The shell is the viewport, give or take a rounding pixel.
		expect(Math.abs(box.height - box.viewport)).toBeLessThanOrEqual(1);
		expect(box.pageScroll).toBeLessThanOrEqual(1);
		// The sidebar does its own scrolling, so the terminals keep the rest.
		expect(box.sidebarScrolls.overflow).toBe('auto');
	});

	test('[TC-PDUI-041] the commit list is a real scroll container with a visible scrollbar', async ({ page }) => {
		const list = await page.evaluate(() => {
			const node = document.querySelector('.pdmux-graph-list') as HTMLElement;
			const rect = node.getBoundingClientRect();
			return {
				scrollHeight: node.scrollHeight,
				clientHeight: node.clientHeight,
				gutter: node.offsetWidth - node.clientWidth,
				bottom: rect.bottom,
				viewport: window.innerHeight,
			};
		});
		// It must actually clip — a list that grew to its content height is exactly
		// the failure this test exists for.
		expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
		expect(list.bottom).toBeLessThanOrEqual(list.viewport + 1);
		// Overlay scrollbars hide the fact that there is anything below the fold, so
		// the gutter must take real space.
		expect(list.gutter).toBeGreaterThan(0);
	});

	/**
	 * ⚠ THE FILE VIEW SCROLLS SIDEWAYS, AND THE SCROLLER IS THE GRID.
	 *
	 * Reported as "the horizontal scroll does not show". It was not an overlay
	 * scrollbar, which is what the terminal's note above would have suggested: this
	 * Chrome reserves 15px for one. The bar existed and sat at the bottom of the CODE
	 * element, which is as tall as the file — 2,916px measured — so it was a screen
	 * and a half below the pane. Moving the overflow onto the grid puts both bars on
	 * the pane's own edges.
	 *
	 * ⚠ WHAT IS ASSERTED IS WHAT EVERY ENGINE AGREES ON. Whether a scrollbar takes
	 * layout is a platform answer — the same page reserves 15px in this Mac's Chrome
	 * and 0 in the bundled headless one — so a guard written on `offsetHeight` would
	 * pass or fail by machine. That it CAN scroll, and that the numbers stay put while
	 * it does, are facts anywhere.
	 */
	test('[TC-PDUI-210] a file view scrolls sideways with its line numbers pinned', async ({ page }) => {
		// Its own screen: mounting it beside the main harness changed what the other
		// specs measured (the page outgrew the viewport, and `[data-pdmux-detail]`
		// matched twice).
		await page.goto('/?screen=tree');
		const blob = page.locator('[data-harness="tree"] .pdmux-blob');
		await blob.waitFor();

		const measured = await page.evaluate(() => {
			const scroller = document.querySelector('[data-harness="tree"] .pdmux-blob') as HTMLElement;
			const gutter = document.querySelector('[data-harness="tree"] .pdmux-blob-gutter') as HTMLElement;
			const left = () => Math.round(gutter.getBoundingClientRect().left);
			const before = left();
			scroller.scrollLeft = 400;
			const after = left();
			const moved = Math.round(scroller.scrollLeft);
			scroller.scrollLeft = 0;
			return {
				client: Math.round(scroller.clientWidth),
				scroll: Math.round(scroller.scrollWidth),
				sticky: getComputedStyle(gutter).position,
				gutterDrift: after - before,
				moved,
			};
		});

		// The harness line is far wider than any column it gets, so this is the case
		// horizontal scrolling exists for.
		expect(measured.scroll, 'the file does not overflow, so nothing is proven').toBeGreaterThan(measured.client);
		expect(measured.moved, 'the grid is not the scroller').toBe(400);
		// ⚠ THE NUMBERS DO NOT SLIDE AWAY. A gutter that scrolls with the code stops
		// naming the lines beside it the moment you move.
		expect(measured.sticky).toBe('sticky');
		expect(measured.gutterDrift, 'the line numbers scrolled away with the code').toBe(0);
	});

	/**
	 * ⚠ FOUND IN THE FILE EXPLORER'S PREVIEW, FIXED IN THE SHARED VIEW. `.pdmux-blob`
	 * is a two-column grid and the truncation note was a THIRD grid item, so it was
	 * auto-placed into the line-number column and its max-content contribution sized
	 * that column. Measured in a 420px dock: gutter 268px, code 140px — the file was
	 * off its own panel, and only ever for files big enough to be truncated, which is
	 * exactly when somebody is squinting at a long file.
	 */
	test('[TC-PDUI-221] the truncation note does not widen the line-number column', async ({ page }) => {
		await page.goto('/?screen=tree');
		await page.locator('[data-harness="tree"] .pdmux-blob').waitFor();
		const measured = await page.evaluate(() => {
			const box = (selector: string): number => {
				const node = document.querySelector(`[data-harness="tree"] ${selector}`) as HTMLElement | null;
				return node ? Math.round(node.getBoundingClientRect().width) : -1;
			};
			return {
				gutter: box('.pdmux-blob-gutter'),
				code: box('.pdmux-blob-code'),
				note: box('[data-pdmux-blob-truncated]'),
				blob: box('.pdmux-blob'),
			};
		});

		// The note must actually be on screen, or this measures nothing.
		expect(measured.note, 'the truncation note is not drawn — the fixture stopped being truncated').toBeGreaterThan(0);
		// Two digits of line number, whatever the font: nowhere near a sentence.
		expect(measured.gutter, 'the gutter is sized by the prose beside it').toBeLessThan(60);
		// And the code keeps the rest of the width rather than a sliver.
		expect(measured.code).toBeGreaterThan(measured.blob / 2);
	});

	test('[TC-PDUI-042] clicking a commit shows the detail INSIDE the viewport', async ({ page }) => {
		await page.locator('.pdmux-graph-row').nth(3).click();
		const detail = page.locator('[data-pdmux-detail]');
		await expect(detail).toBeVisible();
		const probe = await page.evaluate(() => {
			const node = document.querySelector('[data-pdmux-detail]') as HTMLElement;
			const rect = node.getBoundingClientRect();
			const x = rect.left + rect.width / 2;
			const y = rect.top + 8;
			const hit = document.elementFromPoint(x, y);
			return {
				top: rect.top,
				bottom: rect.bottom,
				viewport: window.innerHeight,
				reachable: Boolean(hit && node.contains(hit)),
				overflowY: getComputedStyle(node).overflowY,
				scrollHeight: node.scrollHeight,
				clientHeight: node.clientHeight,
			};
		});
		expect(probe.top).toBeGreaterThanOrEqual(0);
		expect(probe.top).toBeLessThan(probe.viewport);
		// Present in the DOM is not enough: it has to be the thing under that point.
		expect(probe.reachable).toBe(true);
		// And it has to SCROLL. The panel is capped at a share of the column, so a patch
		// longer than the cap is reachable only by scrolling inside it — losing `overflow`
		// makes the rest of the diff unreadable with nothing on screen to say so, which is
		// exactly how it was lost once: an edit split the rule and the property moved to a
		// selector that only matched while the patch was still loading.
		expect(probe.overflowY).toBe('auto');
		expect(probe.scrollHeight, 'the harness patch must exceed the cap, or this proves nothing').toBeGreaterThan(
			probe.clientHeight,
		);
	});

	test('[TC-PDUI-043] the grid lays cells out by mode and they fill the column', async ({ page }) => {
		const cells = await page.evaluate(() => {
			const nodes = [...document.querySelectorAll('[data-pdmux-cell]')].filter(
				(node) => !node.hasAttribute('hidden'),
			) as HTMLElement[];
			const grid = document.querySelector('[data-pdmux-grid]') as HTMLElement;
			const gridRect = grid.getBoundingClientRect();
			return {
				count: nodes.length,
				rects: nodes.map((n) => {
					const r = n.getBoundingClientRect();
					return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
				}),
				grid: { w: Math.round(gridRect.width), h: Math.round(gridRect.height), bottom: gridRect.bottom },
				viewport: window.innerHeight,
			};
		});
		// 4-up is the default: two columns, two rows, all four on screen.
		expect(cells.count).toBe(4);
		expect(new Set(cells.rects.map((r) => r.x)).size).toBe(2);
		expect(new Set(cells.rects.map((r) => r.y)).size).toBe(2);
		for (const rect of cells.rects) {
			expect(rect.w).toBeGreaterThan(50);
			expect(rect.h).toBeGreaterThan(50);
		}
		// The grid takes the remaining height instead of sitting in a fixed box.
		expect(cells.grid.bottom).toBeLessThanOrEqual(cells.viewport + 1);
		expect(cells.grid.h).toBeGreaterThan(cells.viewport * 0.7);
	});

	test('[TC-PDUI-044] a splitter drag resizes the sidebar across the terminal area', async ({ page }) => {
		const handle = page.locator('[data-pdmux-handle]').first();
		const before = await page.evaluate(
			() => (document.querySelector('[data-pdmux-sidebar]') as HTMLElement).getBoundingClientRect().width,
		);
		const box = (await handle.boundingBox())!;
		await page.mouse.move(box.x + box.width / 2, box.y + 200);
		await page.mouse.down();
		// Dragging RIGHT crosses the terminal panes: with a document-level listener the
		// drag would freeze the moment the pointer entered one.
		await page.mouse.move(box.x + 160, box.y + 200, { steps: 8 });
		await page.mouse.up();
		const after = await page.evaluate(
			() => (document.querySelector('[data-pdmux-sidebar]') as HTMLElement).getBoundingClientRect().width,
		);
		expect(after).toBeGreaterThan(before + 100);
	});

	/**
	 * REPORTED as "the sidebar's right margin is bigger than its left", and invisible to
	 * every DOM assertion: `padding: 16px` was symmetric in the stylesheet and asymmetric
	 * on screen, because `scrollbar-gutter: stable` reserves the scrollbar's width OUTSIDE
	 * the padding box. Measured at 1440px the cards ended 32px clear of the right edge
	 * against 16px on the left. So the padding is deliberately lopsided now, and the thing
	 * worth locking is not the declaration but the RESULT.
	 */
	test('[TC-PDUI-195] the sidebar leaves the same gap on both sides of its cards', async ({ page }) => {
		const gaps = await page.evaluate(() => {
			const side = document.querySelector('[data-pdmux-sidebar]') as HTMLElement;
			const card = side.querySelector('[data-pdmux-host]') as HTMLElement;
			const sr = side.getBoundingClientRect();
			const cr = card.getBoundingClientRect();
			// ⚠ THE BORDER IS NOT PART OF THE GAP. `getBoundingClientRect().right`
			// includes the column's 1px right border while its `.left` has no border to
			// include, so comparing the two raw distances reads a symmetric column as
			// 1px out. The gap a person sees runs from the card to the border.
			const borderRight = parseFloat(getComputedStyle(side).borderRightWidth) || 0;
			return {
				left: Math.round(cr.left - sr.left),
				right: Math.round(sr.right - borderRight - cr.right),
				gutter: side.offsetWidth - side.clientWidth,
			};
		});
		// The arithmetic only has anything to balance where the scrollbar is LAID OUT. On a
		// platform with overlay scrollbars nothing is reserved, the rule under test does not
		// apply, and asserting it would fail for a reason that is not a defect.
		test.skip(gaps.gutter <= 1, `overlay scrollbars — no gutter to balance (${gaps.gutter}px)`);
		expect(gaps.right, `left ${gaps.left}px vs right ${gaps.right}px (gutter ${gaps.gutter}px)`).toBe(gaps.left);
	});

	test('[TC-PDUI-170] a saved dock width yields to the viewport instead of crushing the terminals', async ({ page }) => {
		/**
		 * `--pdmux-right` is persisted from whatever window it was chosen on. Taken
		 * literally on a narrower viewport, sidebar + dock are fixed and the 1fr
		 * terminals track gets the scraps: measured before the clamp, 751px of dock on a
		 * 1280px viewport left 217px for six terminals — 59px each. The dock is the one
		 * that yields; the stored preference itself is untouched, so a wide window gets
		 * the chosen width back.
		 */
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.evaluate(() => {
			const shell = document.querySelector('.pdmux-shell') as HTMLElement;
			shell.style.setProperty('--pdmux-right', '751px');
		});
		const widths = await page.evaluate(() => {
			const shell = document.querySelector('.pdmux-shell') as HTMLElement;
			const w = (sel: string): number =>
				Math.round((shell.querySelector(sel) as HTMLElement).getBoundingClientRect().width);
			return { terminals: w('.pdmux-panel'), dock: w('.pdmux-graph'), total: Math.round(shell.getBoundingClientRect().width) };
		});
		// The terminal region keeps a working floor; the dock shrank to make it true.
		expect(widths.terminals).toBeGreaterThanOrEqual(295);
		expect(widths.dock).toBeLessThan(751);
		expect(widths.total).toBe(1280);

		// And a viewport that CAN afford the choice gives it back in full.
		await page.setViewportSize({ width: 1920, height: 963 });
		const wide = await page.evaluate(() =>
			Math.round((document.querySelector('.pdmux-shell .pdmux-graph') as HTMLElement).getBoundingClientRect().width),
		);
		expect(wide).toBe(751);
	});

	test('[TC-PDUI-173] below the stack breakpoint, CSS alone shows exactly one cell', async ({ page }) => {
		/**
		 * The harness renders the FULL layout with no JS projection — exactly what a
		 * narrow viewport receives when the server guessed the device wrong. The
		 * stylesheet must turn that into a single visible cell by itself, or the refresh
		 * flashes a 3x3 that collapses at hydration.
		 */
		await page.setViewportSize({ width: 480, height: 900 });
		const narrow = await page.evaluate(() => {
			const cells = [...document.querySelectorAll('[data-pdmux-cell]')];
			const visible = cells.filter((c) => (c as HTMLElement).offsetParent !== null && (c as HTMLElement).getBoundingClientRect().width > 0);
			return {
				total: cells.length,
				visible: visible.length,
				anchor: visible.map((c) => c.getAttribute('data-pdmux-stack')),
				gridCols: getComputedStyle(document.querySelector('[data-pdmux-grid]') as HTMLElement).gridTemplateColumns.split(' ').length,
			};
		});
		expect(narrow.total).toBeGreaterThan(1);
		expect(narrow.visible).toBe(1);
		expect(narrow.anchor).toEqual(['anchor']);
		expect(narrow.gridCols).toBe(1);

		// Back on a desktop width the marking is inert and every cell returns.
		await page.setViewportSize({ width: 1280, height: 900 });
		const wide = await page.evaluate(
			() => [...document.querySelectorAll('[data-pdmux-cell]')].filter((c) => (c as HTMLElement).getBoundingClientRect().width > 0).length,
		);
		expect(wide).toBeGreaterThan(1);
	});

	test('[TC-PDUI-174] the lane overlay covers every row, at any row height', async ({ page }) => {
		/**
		 * REPORTED ON A PHONE: scrolling the commit list down showed no lanes and no dots
		 * at all past a point. The SVG is an absolute overlay sized from `GEOM.row` (24),
		 * while `@media (pointer: coarse)` renders 40px rows — so the overlay was `24n`
		 * tall over a `40n` list and simply ended ~60% of the way down. Above that it also
		 * drifted 16px per row, putting a dot beside the WRONG commit within three rows.
		 *
		 * Driven through `--pdmux-row` rather than touch emulation: that variable is what
		 * the media query sets, and this runs on Desktop Chrome. 24 is the desktop value,
		 * 40 the coarse-pointer one.
		 */
		for (const rowHeight of [24, 40]) {
			await page.evaluate((height) => {
				// EVERY `.pdmux` root, not just the shell: `--pdmux-row` is declared on the
				// `.pdmux` class itself, and `.pdmux-graph` carries that class too — so the
				// inner declaration shadows an override put only on the shell. The media
				// query has the same reach, which is why production is unaffected.
				for (const root of document.querySelectorAll('.pdmux')) {
					(root as HTMLElement).style.setProperty('--pdmux-row', `${height}px`);
				}
			}, rowHeight);
			// The component measures the rendered row, so wait for the layout to settle.
			await page.waitForFunction((height) => {
				const row = document.querySelector('.pdmux-graph-row');
				return Boolean(row) && Math.abs(row!.getBoundingClientRect().height - height) < 0.5;
			}, rowHeight);
			// The rows reach their new height before the component has re-measured and
			// re-rendered the overlay, so poll for the two agreeing rather than sampling
			// once — a single sample here fails about one run in three.
			await expect
				.poll(async () =>
					page.evaluate(() => {
						const rows = document.querySelector('.pdmux-graph-rows') as HTMLElement;
						const svg = document.querySelector('.pdmux-graph-svg') as SVGSVGElement;
						return Math.round(
							Math.abs(svg.getBoundingClientRect().height - rows.getBoundingClientRect().height),
						);
					}),
				)
				.toBeLessThanOrEqual(1);

			// Reproduce the report: go to the bottom of the list.
			await page.evaluate(() => {
				const list = document.querySelector('.pdmux-graph-list') as HTMLElement;
				list.scrollTo(0, list.scrollHeight);
			});

			const probe = await page.evaluate(() => {
				const rows = document.querySelector('.pdmux-graph-rows') as HTMLElement;
				const svg = document.querySelector('.pdmux-graph-svg') as SVGSVGElement;
				const buttons = [...document.querySelectorAll('.pdmux-graph-row')] as HTMLElement[];
				const last = buttons[buttons.length - 1]!.getBoundingClientRect();
				const centre = (node: Element): number => {
					const rect = node.getBoundingClientRect();
					return rect.top + rect.height / 2;
				};
				const dots = [...svg.querySelectorAll('.pdmux-dot')];
				return {
					rowsHeight: rows.getBoundingClientRect().height,
					svgHeight: svg.getBoundingClientRect().height,
					rowCount: buttons.length,
					dotCount: dots.length,
					// The dot for the LAST row has to be ON the last row.
					dotOnLastRow: dots.some((dot) => centre(dot) >= last.top && centre(dot) <= last.bottom),
					// And the first row's dot on the first row — the drift shows up here first.
					dotOnFirstRow: (() => {
						const first = buttons[0]!.getBoundingClientRect();
						return dots.some((dot) => centre(dot) >= first.top && centre(dot) <= first.bottom);
					})(),
				};
			});

			// The overlay is exactly as tall as the stack it covers; any shortfall is a
			// region of the list with no graph in it.
			expect(Math.abs(probe.svgHeight - probe.rowsHeight)).toBeLessThanOrEqual(1);
			expect(probe.dotCount).toBe(probe.rowCount);
			expect(probe.dotOnLastRow).toBe(true);
			expect(probe.dotOnFirstRow).toBe(true);
		}
	});

	test('[TC-PDUI-181] the output sheet fits the screen and scrolls inside itself', async ({ page }) => {
		/**
		 * The sheet must NOT inherit its pane's box. A terminal in a 3x3 grid is a few
		 * hundred pixels tall, so a sheet anchored to it would be narrower than the terminal
		 * whose output it is showing; it is centred and clamped to the viewport instead.
		 *
		 * Opened once and then RESIZED, rather than opened per width: that is what proves it
		 * follows the viewport, and it dodges the harness's own overlap at 320px (the dock
		 * sits over the pane header there, so a second click never lands).
		 */
		await page.locator('[data-pdmux-pane]:not([hidden]) [data-pdmux-history]').first().click();
		await expect(page.locator('[data-testid="terminal-history"]')).toBeVisible();

		const measure = () =>
			page.evaluate(() => {
				const sheet = document.querySelector('[data-testid="terminal-history"]') as HTMLElement;
				const body = sheet.querySelector('[data-pdmux-history-body]') as HTMLElement;
				const box = sheet.getBoundingClientRect();
				return {
					withinViewport:
						box.left >= -1 &&
						box.right <= window.innerWidth + 1 &&
						box.top >= -1 &&
						box.bottom <= window.innerHeight + 1,
					width: Math.round(box.width),
					viewportWidth: window.innerWidth,
					// The body is the scroller, and it must be the thing that clips.
					bodyOverflow: getComputedStyle(body).overflowY,
					bodyFocusable: body.getAttribute('tabindex') === '0',
					// Long terminal lines must wrap, or the reader loses the left edge —
					// which is where the prompt is.
					wraps: getComputedStyle(body.querySelector('pre') as HTMLElement).whiteSpace,
					pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
				};
			});

		for (const width of [1280, 320]) {
			await page.setViewportSize({ width, height: 720 });
			const probe = await measure();
			expect(probe.withinViewport, `the sheet left the ${width}px viewport`).toBe(true);
			expect(probe.width).toBeLessThanOrEqual(probe.viewportWidth);
			expect(probe.bodyOverflow).toBe('auto');
			expect(probe.bodyFocusable, 'the scroller cannot be reached from a keyboard').toBe(true);
			expect(probe.wraps).toBe('pre-wrap');
			// A modal must not make the page itself scroll sideways.
			expect(probe.pageScroll).toBeLessThanOrEqual(1);
		}

		await page.setViewportSize({ width: 1280, height: 800 });
		await page.locator('[data-testid="terminal-history-close"]').click();
		await expect(page.locator('[data-testid="terminal-history"]')).toBeHidden();
	});

	test('[TC-PDUI-181] a note above the sheet’s scroller costs the body nothing', async ({ page }) => {
		/**
		 * ⚠ THE NOTE IS A NEW ROW ABOVE A FLEX SCROLLER, which is the exact shape of this file's
		 * founding bug: a box added above one pushed the real content ~7,300px below a viewport
		 * that clips, and every DOM assertion stayed green because the content was still THERE.
		 * So each of the sheet's states is measured, not just rendered.
		 *
		 * The states differ only in that row: `screen` (a full-screen program owns the pane),
		 * `failed` (the host could not be asked) and `never` (the answer has not arrived) each add
		 * one line that `full` does not have.
		 */
		for (const state of ['full', 'screen', 'failed', 'never'] as const) {
			await page.goto(`/?history=${state}`);
			await page.waitForSelector('[data-pdmux-grid]');
			await page.locator('[data-pdmux-pane]:not([hidden]) [data-pdmux-history]').first().click();
			await expect(page.locator('[data-testid="terminal-history"]')).toBeVisible();

			const probe = await page.evaluate(() => {
				const sheet = document.querySelector('[data-testid="terminal-history"]') as HTMLElement;
				const body = sheet.querySelector('[data-pdmux-history-body]') as HTMLElement;
				const note = sheet.querySelector('[data-pdmux-history-note]') as HTMLElement | null;
				const sheetBox = sheet.getBoundingClientRect();
				const bodyBox = body.getBoundingClientRect();
				const noteBox = note?.getBoundingClientRect() ?? null;
				return {
					note: note?.dataset.pdmuxHistoryNote ?? null,
					// The body has to keep real height and stay inside the sheet.
					bodyHeight: Math.round(bodyBox.height),
					bodyInsideSheet: bodyBox.bottom <= sheetBox.bottom + 1 && bodyBox.top >= sheetBox.top - 1,
					// The note belongs ABOVE the scroller and inside the sheet — not over the text,
					// which is the other way a row like this goes wrong.
					noteAboveBody: noteBox === null || noteBox.bottom <= bodyBox.top + 1,
					noteInsideSheet: noteBox === null || (noteBox.top >= sheetBox.top - 1 && noteBox.bottom <= sheetBox.bottom + 1),
					sheetInViewport: sheetBox.bottom <= window.innerHeight + 1 && sheetBox.top >= -1,
					scrolls: body.scrollHeight > body.clientHeight,
					pageScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
				};
			});

			expect(probe.note, `the ${state} sheet showed the wrong note`).toBe(
				state === 'full' ? null : state === 'never' ? 'pending' : state === 'failed' ? 'failed' : 'screen',
			);
			// ⚠ NOT ZERO, AND NOT A SLIVER. A body squeezed to nothing is the failure mode here,
			// and `isVisible()` cannot see it. The pane prints forty rows in every state, so a
			// short body means the note took the height rather than that there was nothing to show.
			expect(probe.bodyHeight, `the ${state} sheet crushed its own scroller`).toBeGreaterThan(100);
			expect(probe.bodyInsideSheet, `the ${state} sheet pushed its body out of itself`).toBe(true);
			expect(probe.noteAboveBody, `the ${state} sheet drew its note over the output`).toBe(true);
			expect(probe.noteInsideSheet, `the ${state} sheet put its note outside itself`).toBe(true);
			expect(probe.sheetInViewport, `the ${state} sheet left the viewport`).toBe(true);
			expect(probe.pageScroll, 'the sheet made the page itself scroll').toBeLessThanOrEqual(1);
			// The one state with a long history in it must still be the thing that scrolls.
			if (state === 'full') expect(probe.scrolls, 'a 400-line history did not become scrollable').toBe(true);
		}
	});

	test('[TC-PDUI-176] a long host name stays on one line and inside its card', async ({ page }) => {
		/**
		 * The header had no rule for `[data-pdmux-name]` at all. A flex item defaults to
		 * `min-width: auto`, so the span would not shrink below its content: a long unbroken
		 * token overflowed the card and shoved the ⚙ past the edge, and a multi-word label
		 * wrapped and made that card taller than its neighbours.
		 *
		 * Measured here rather than asserted in the DOM, because "wrapped" and "overflowed"
		 * are both invisible to a DOM query — the text is present and correct either way.
		 */
		const probe = await page.evaluate(() => {
			const cards = [...document.querySelectorAll('.pdmux-card')] as HTMLElement[];
			const read = (card: HTMLElement) => {
				const name = card.querySelector('[data-pdmux-name]') as HTMLElement;
				const cog = card.querySelector('.pdmux-cog') as HTMLElement;
				const head = card.querySelector('.pdmux-card-head') as HTMLElement;
				const line = parseFloat(getComputedStyle(name).lineHeight) || name.offsetHeight;
				return {
					text: name.textContent ?? '',
					lines: Math.round(name.getBoundingClientRect().height / line),
					// Does the name spill past the card, and is the ⚙ still inside it?
					nameOverflow: Math.round(name.getBoundingClientRect().right - card.getBoundingClientRect().right),
					cogOverflow: Math.round(cog.getBoundingClientRect().right - card.getBoundingClientRect().right),
					headHeight: Math.round(head.getBoundingClientRect().height),
					truncated: name.scrollWidth > name.clientWidth,
				};
			};
			return cards.map(read);
		});

		expect(probe.length).toBeGreaterThan(1);
		const long = probe.find((c) => c.text.startsWith('ip-10-0-12-233'))!;
		const short = probe.find((c) => c.text === 'alpha')!;

		expect(long.lines, 'the host name must stay on one line').toBe(1);
		expect(long.nameOverflow, 'the name spills past its card').toBeLessThanOrEqual(0);
		expect(long.cogOverflow, 'the name pushed the settings button off the card').toBeLessThanOrEqual(0);
		// A long name must not make its card header taller than a short one's.
		expect(long.headHeight).toBe(short.headHeight);
		// And the reason it fits has to be truncation, not luck with the viewport.
		expect(long.truncated, 'the fixture is not actually long enough to truncate').toBe(true);
	});

	test('[TC-PDUI-214] folding a card shortens it without reshaping its header', async ({ page }) => {
		/**
		 * The fold control is a FOURTH thing in a header that already truncates its name,
		 * and both of its costs are invisible to a DOM query: the chevron can steal width
		 * from the name, and its 36px box can make the header taller than the ⚙ was
		 * holding it. Neither shows up as a missing element, so both are measured.
		 *
		 * ⚠ ONE CARD, BOTH STATES. Comparing two different cards would compare two
		 * different names; the regression is a single card changing shape as it folds.
		 *
		 * Measured: Chromium (bundled, headless), macOS, dpr 1, 2026-08-13. Only
		 * differences and orderings are asserted — never an absolute pixel count — so the
		 * numbers below do not have to be reproduced on another engine.
		 */
		const card = page.locator('.pdmux-card').first();
		const read = async () =>
			card.evaluate((el) => {
				const head = el.querySelector('.pdmux-card-head') as HTMLElement;
				const name = el.querySelector('[data-pdmux-name]') as HTMLElement;
				const fold = el.querySelector('[data-pdmux-fold]') as HTMLElement;
				const cog = el.querySelector('.pdmux-cog') as HTMLElement;
				return {
					card: Math.round(el.getBoundingClientRect().height),
					head: Math.round(head.getBoundingClientRect().height),
					name: Math.round(name.getBoundingClientRect().width),
					widgets: el.querySelectorAll('[data-pdmux-widget]').length,
					expanded: fold.getAttribute('aria-expanded'),
					// ⚠ MEASURED AGAINST THE ⚙, NEVER WRITTEN DOWN. These two buttons share one
					// box in the stylesheet precisely so the header's height has a single
					// definition; asserting a literal 36 would pass a card whose two controls
					// had quietly drifted apart, and would have to be re-measured on every
					// engine. Comparing them catches the drift and travels.
					foldBox: Math.round(fold.getBoundingClientRect().height),
					cogBox: Math.round(cog.getBoundingClientRect().height),
					// The chevron opens the header, the ⚙ closes it: anything else means one
					// of them jumped the name it is meant to sit beside.
					order: fold.getBoundingClientRect().left < name.getBoundingClientRect().left,
					cogInside: Math.round(cog.getBoundingClientRect().right - el.getBoundingClientRect().right),
					foldInside: Math.round(el.getBoundingClientRect().left - fold.getBoundingClientRect().left),
				};
			});

		const open = await read();
		expect(open.expanded).toBe('true');
		expect(open.order, 'the chevron must precede the name it discloses').toBe(true);
		expect(open.widgets).toBeGreaterThan(0);
		expect(open.foldBox, 'the fold control is not the size of the ⚙ beside it').toBe(open.cogBox);

		await card.locator('[data-pdmux-fold]').click();
		const shut = await read();

		expect(shut.expanded).toBe('false');
		// The point of the feature: the card gives its column back.
		expect(shut.card, 'folding did not shorten the card').toBeLessThan(open.card);
		expect(shut.widgets, 'a folded card still draws widgets').toBe(0);
		// …and the point of this test: the header did not move while it happened.
		expect(shut.head, 'the header changed height as the card folded').toBe(open.head);
		expect(shut.name, 'the header reflowed and resized the name').toBe(open.name);
		expect(shut.order).toBe(true);
		expect(shut.cogInside, 'the settings button left the card').toBeLessThanOrEqual(0);
		expect(shut.foldInside, 'the chevron left the card').toBeLessThanOrEqual(0);
	});

	test('[TC-PDUI-183] an agent name is written properly and still fits its column', async ({ page }) => {
		/**
		 * The provider id is a wire value — lowercase, matched against a process name — and
		 * it was printed straight onto the card, so a product called Claude appeared as
		 * "claude". Capitalising it makes the label wider, and the column it sits in is a
		 * fixed 44px box with an ellipsis: a name that no longer fits would trade one
		 * cosmetic bug for a worse one, and `text-overflow` hides that silently.
		 */
		const labels = await page.evaluate(() =>
			[...document.querySelectorAll('.pdmux-agent-label')].map((el) => {
				const node = el as HTMLElement;
				return {
					text: (node.textContent ?? '').trim(),
					// `scrollWidth > clientWidth` is the only way to see an ellipsis; the text
					// is present and correct in the DOM either way.
					clipped: node.scrollWidth > node.clientWidth + 0.5,
				};
			}),
		);

		expect(labels.length, 'no agent rows rendered, so this proves nothing').toBeGreaterThan(0);
		for (const label of labels) {
			expect(label.text, 'an agent row rendered no name').not.toBe('');
			// The id is lowercase; a rendered name that still starts lowercase means the
			// display name never got applied.
			expect(label.text[0], `"${label.text}" is not written as a name`).toBe(label.text[0]!.toUpperCase());
			expect(label.clipped, `"${label.text}" no longer fits its column`).toBe(false);
		}
	});

	test('[TC-PDUI-211] every metric label fits its column and leaves the sparkline room', async ({ page }) => {
		/**
		 * `.pdmux-metric-label` is a fixed box with `flex: none` and NO overflow rule,
		 * inside a `white-space: nowrap` parent — so a label too wide for it does not
		 * ellipsise, it draws straight over the percentage next to it. Adding SWAP put
		 * a capital W where the widest previous label had an I, and this package
		 * declares no `font-family`, so the answer depends on whatever the consuming
		 * app supplies. That is exactly the kind of thing that must be measured rather
		 * than reasoned about.
		 */
		const cards = await page.evaluate(() =>
			[...document.querySelectorAll('.pdmux-widget[data-pdmux-widget="resources"]')].map((widget) =>
				[...widget.querySelectorAll('.pdmux-row')].map((row) => {
					const label = row.querySelector('.pdmux-metric-label') as HTMLElement;
					const value = row.querySelector('.pdmux-metric-value') as HTMLElement;
					const spark = row.querySelector('svg.pdmux-spark');
					// ⚠ MEASURED WITH A Range, NOT WITH scrollWidth. scrollWidth is an
					// integer, so a 34.22px label in a 34px box reports 34 and reads as a
					// fit — which is exactly what SWAP did, and what let it spend the row's
					// gap unnoticed. A Range gives the true sub-pixel text width.
					const range = document.createRange();
					range.selectNodeContents(label);
					return {
						text: (label.textContent ?? '').trim(),
						textWidth: range.getBoundingClientRect().width,
						boxWidth: label.clientWidth,
						// The label must not reach into the value's box either.
						overlaps: label.getBoundingClientRect().right > value.getBoundingClientRect().left + 0.5,
						sparkWidth: spark ? spark.getBoundingClientRect().width : 0,
					};
				}),
			),
		);

		expect(cards.length, 'no resource widgets rendered, so this proves nothing').toBeGreaterThan(0);
		for (const rows of cards) {
			expect(rows.map((r) => r.text)).toEqual(['CPU', 'MEM', 'SWAP', 'DISK']);
			for (const row of rows) {
				expect(
					row.textWidth,
					`"${row.text}" is ${row.textWidth.toFixed(2)}px in a ${row.boxWidth}px column`,
				).toBeLessThanOrEqual(row.boxWidth);
				expect(row.overlaps, `"${row.text}" is drawing over its own percentage`).toBe(false);
			}
			// The harness gives CPU and SWAP history and gives MEM and DISK none, so a
			// sparkline on exactly those two is also the proof that `history[key]` reaches
			// the new key — a swap row wired to nothing would look identical otherwise.
			const drawn = rows.filter((r) => r.sparkWidth > 0).map((r) => r.text);
			expect(drawn).toEqual(['CPU', 'SWAP']);
			for (const row of rows.filter((r) => r.sparkWidth > 0)) {
				// A widened label steals from the sparkline, which is `flex: 1 1 0` inside a
				// 300px sidebar — squeezing it to nothing is the other way to break this row.
				expect(row.sparkWidth, `"${row.text}" left the sparkline no room`).toBeGreaterThan(40);
			}
		}
	});

	test('[TC-PDUI-177] every card states its reachability without relying on colour', async ({ page }) => {
		// The busy/idle chip was dropped, but the stopped/unknown one was deliberately kept:
		// "without it a card whose every value is a dash looks broken instead of switched
		// off". The glyph inherits that duty, so it must exist on every card and carry a name.
		//
		// ⚠ IT WAS AN 8px DISC AND THE ONLY THING IT SAID WAS ITS HUE — reported as looking
		// wrong beside the ⚙, which it was: a pinhead next to a 16px drawing. So this asks
		// for the two things a DOM assertion cannot see. That it is DRAWN: a glyph whose
		// paths never rendered has an empty bounding box while the element itself still
		// measures 16px, so the box is the only honest witness. And that it MATCHES THE ⚙:
		// the requirement was "the size of the settings icon", and the ⚙ is measured here
		// rather than restated as a number, so the two cannot drift apart silently.
		const marks = await page.evaluate(() =>
			[...document.querySelectorAll('.pdmux-card')].map((card) => {
				const dot = card.querySelector('.pdmux-state-dot') as HTMLElement | null;
				const cog = card.querySelector('.pdmux-cog svg') as SVGGraphicsElement | null;
				if (!dot || !cog) return null;
				const svg = dot.querySelector('svg') as SVGGraphicsElement | null;
				const box = dot.getBoundingClientRect();
				return {
					reach: dot.dataset.pdmuxReach,
					label: dot.getAttribute('aria-label') ?? '',
					// The stroke is what carries the accent now that there is no fill.
					painted: svg ? getComputedStyle(svg).stroke : '',
					size: Math.round(box.width),
					cogSize: Math.round(cog.getBoundingClientRect().width),
					// Non-zero only if the paths actually rendered something.
					inked: svg ? Math.round(svg.getBBox().width) : 0,
				};
			}),
		);

		expect(marks.length).toBeGreaterThan(0);
		for (const mark of marks) {
			expect(mark, 'a card rendered no reachability mark at all').not.toBeNull();
			expect(mark!.label.length, 'the mark carries no accessible state name').toBeGreaterThan(0);
			expect(mark!.size, 'the reachability mark is not the size of the ⚙ beside it').toBe(mark!.cogSize);
			expect(mark!.inked, 'the glyph box is empty — the paths drew nothing').toBeGreaterThan(0);
			// A token that failed to resolve leaves the stroke unpainted.
			expect(mark!.painted).not.toBe('none');
			expect(mark!.painted).not.toBe('rgba(0, 0, 0, 0)');
		}
	});

	test('[TC-PDUI-185] a disabled host is not drawn as a disconnected one', async ({ page }) => {
		/**
		 * `unknown` (nobody is asking) has to stay separable from `offline` (asked, no
		 * answer) — collapsing them reports a switched-off machine as a broken one, which is
		 * the reason this mark exists at all rather than being dropped with the busy/idle chip.
		 *
		 * The separation is a DASHED stroke on the joined link, and the dash lives in the
		 * stylesheet, so the unit specs cannot see it: jsdom loads no CSS. Driving the state
		 * through the attribute the rule keys on is the point — this asserts the SELECTOR,
		 * which is the part that silently stops matching when a class is renamed.
		 */
		const dash = await page.evaluate(() => {
			const dot = document.querySelector('.pdmux-state-dot') as HTMLElement;
			const svg = dot.querySelector('svg') as SVGElement;
			const read = (): { dash: string; colour: string } => ({
				dash: getComputedStyle(svg).strokeDasharray,
				colour: getComputedStyle(svg).stroke,
			});
			const online = read();
			dot.dataset.pdmuxReach = 'unknown';
			const unknown = read();
			dot.dataset.pdmuxReach = 'offline';
			const offline = read();
			return { online, unknown, offline };
		});

		// A solid line reports its dash pattern as `none` — so this fails if the rule stops
		// matching, which is the only way the two states become one picture again.
		expect(dash.online.dash, 'a reachable host should draw a solid link').toBe('none');
		expect(dash.offline.dash, 'a disconnected host should draw a solid link, parted').toBe('none');
		expect(dash.unknown.dash, 'a disabled host is drawn exactly like a reachable one').not.toBe('none');
		// And the three still differ in colour, which is the accent on top of the shape.
		expect(new Set([dash.online.colour, dash.unknown.colour, dash.offline.colour]).size).toBe(3);
	});

	test('[TC-PDUI-175] selecting the bottom-most commit does not hide it behind the detail', async ({ page }) => {
		/**
		 * REPORTED: picking one of the last visible commits opened the detail panel
		 * underneath, and the panel covered the very row that opened it. The list and the
		 * detail share one column, so opening the panel SHRINKS the list — the row never
		 * moves, the floor rises past it.
		 */
		const sha = await page.evaluate(() => {
			const list = document.querySelector('.pdmux-graph-list') as HTMLElement;
			list.scrollTo(0, list.scrollHeight);
			const bounds = list.getBoundingClientRect();
			const onScreen = [...document.querySelectorAll<HTMLElement>('.pdmux-graph-row')].filter((row) => {
				const box = row.getBoundingClientRect();
				return box.top >= bounds.top && box.bottom <= bounds.bottom + 1;
			});
			return onScreen[onScreen.length - 1]!.dataset.pdmuxSha!;
		});

		await page.locator(`.pdmux-graph-row[data-pdmux-sha="${sha}"]`).click();
		await expect(page.locator('[data-pdmux-detail]')).toBeVisible();
		// The correction is coalesced into one animation frame, so the panel becoming
		// visible does not mean the scroll has happened yet. Poll instead of sampling once
		// — a single sample here passed only on retry, which is worse than failing.
		await expect
			.poll(async () =>
				page.evaluate((target) => {
					const list = document.querySelector('.pdmux-graph-list') as HTMLElement;
					const row = document.querySelector(`.pdmux-graph-row[data-pdmux-sha="${target}"]`) as HTMLElement;
					return Math.round(list.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom);
				}, sha),
			)
			.toBeGreaterThanOrEqual(-1);

		const after = await page.evaluate((target) => {
			const list = document.querySelector('.pdmux-graph-list') as HTMLElement;
			const row = document.querySelector(`.pdmux-graph-row[data-pdmux-sha="${target}"]`) as HTMLElement;
			const bounds = list.getBoundingClientRect();
			const box = row.getBoundingClientRect();
			return {
				selected: row.getAttribute('aria-current'),
				above: box.top - bounds.top,
				below: bounds.bottom - box.bottom,
				// Present in the DOM is not the question — is it the thing under that point?
				reachable: (() => {
					const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
					return Boolean(hit && (row === hit || row.contains(hit)));
				})(),
			};
		}, sha);

		expect(after.selected).toBe('true');
		// Still inside the list on both edges — the panel pushed it up rather than over it.
		expect(after.below, 'the detail panel is covering the row that opened it').toBeGreaterThanOrEqual(-1);
		expect(after.above).toBeGreaterThanOrEqual(-1);
		expect(after.reachable).toBe(true);
	});

	/**
	 * ⚠ THIS PANEL HAD NO BROWSER COVERAGE AT ALL until the column header was added.
	 * The header is the one part of it that CANNOT be verified in jsdom: lining up with
	 * the cells below is a question about pixels, and the failure mode is a table whose
	 * columns are a scrollbar's width out of step with their own values.
	 */
	const filesGeometry = (page: import('@playwright/test').Page) =>
		page.evaluate(() => {
			const body = document.querySelector('[data-pdmux-files-body]') as HTMLElement;
			const head = document.querySelector('[data-pdmux-files-head]') as HTMLElement;
			const row = document.querySelector('.pdmux-files-row') as HTMLElement;
			const edges = (node: Element | null) => {
				if (!node) return null;
				const rect = node.getBoundingClientRect();
				return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
			};
			const columns = ['size', 'modified', 'mode'] as const;
			return {
				headTop: Math.round(head.getBoundingClientRect().top),
				bodyTop: Math.round(body.getBoundingClientRect().top),
				scrolls: body.scrollHeight > body.clientHeight + 1,
				rowHeight: Math.round(row.getBoundingClientRect().height),
				name: {
					head: edges(head.querySelector('.pdmux-files-cell-name')),
					cell: edges(row.querySelector('.pdmux-files-name')),
				},
				columns: columns.map((key) => ({
					key,
					head: edges(head.querySelector(`[data-pdmux-cell='${key}']`)),
					cell: edges(row.querySelector(`.pdmux-files-${key}`)),
				})),
			};
		});

	for (const width of [420, 260]) {
		test(`[TC-PDUI-224] the file listing's header lines up with its cells at ${width}px`, async ({ page }) => {
			await page.goto(`/?screen=files&width=${width}`);
			await page.waitForSelector('[data-pdmux-files-head]');
			const box = await filesGeometry(page);

			// ⚠ THE NAME COLUMN IS NEVER 0px. This is the 420px → 0px incident as an
			// assertion: a horizontal row of fixed-width siblings crushed the one column
			// somebody was reading, and nothing measured it.
			expect(box.name.cell?.width ?? 0).toBeGreaterThan(60);
			expect(box.name.head?.width ?? 0).toBeGreaterThan(60);

			// A column that is drawn must be drawn in the same place in both rows. A
			// column that is not drawn must be absent from BOTH — a header for a value
			// nobody shows is worse than no header.
			for (const column of box.columns) {
				if (!column.head) {
					expect(column.cell, `${column.key} has a cell but no header`).toBeNull();
					continue;
				}
				expect(column.cell, `${column.key} has a header but no cell`).not.toBeNull();
				expect(Math.abs((column.head.left ?? 0) - (column.cell?.left ?? 0))).toBeLessThanOrEqual(1);
				expect(Math.abs((column.head.right ?? 0) - (column.cell?.right ?? 0))).toBeLessThanOrEqual(1);
			}

			// The icon must not make the row taller — 12px/1.5 plus 3px of padding either
			// side is 24px, and a 16px icon would push every row past it.
			expect(box.rowHeight).toBeLessThanOrEqual(26);

			// A listing longer than the panel scrolls, and the header stays put while it
			// does — a header that scrolls away is a header that was not worth the row.
			expect(box.scrolls).toBe(true);
			await page.evaluate(() => {
				(document.querySelector('[data-pdmux-files-body]') as HTMLElement).scrollTop = 200;
			});
			const scrolled = await filesGeometry(page);
			expect(scrolled.headTop).toBe(scrolled.bodyTop);
		});
	}

	test('[TC-PDUI-225] dragging a column edge moves the header and the cells together', async ({ page }) => {
		await page.goto('/?screen=files&width=520');
		await page.waitForSelector('[data-pdmux-files-head]');
		const before = await filesGeometry(page);
		const target = before.columns.find((column) => column.key === 'modified');
		expect(target?.head, 'the harness must draw the column this drags').toBeTruthy();

		const grip = page.locator("[data-pdmux-cell='modified'] [data-pdmux-handle]");
		const box = await grip.boundingBox();
		expect(box, 'the grip must be hit-testable, not a 0px overlay').toBeTruthy();
		// Dragging LEFT widens a column whose edge is on its leading side. `steps` matters:
		// the handle reports a delta per pointermove, and one jump would not exercise it.
		await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
		await page.mouse.down();
		await page.mouse.move(box!.x + box!.width / 2 - 40, box!.y + box!.height / 2, { steps: 8 });
		await page.mouse.up();

		const after = await filesGeometry(page);
		const grown = after.columns.find((column) => column.key === 'modified');
		expect((grown?.head?.width ?? 0) - (target?.head?.width ?? 0)).toBeGreaterThan(20);
		// ⚠ BOTH, BY THE SAME AMOUNT. One number drives both rows; a drag that moved only
		// the header would leave every value under the wrong label.
		expect(Math.abs((grown?.head?.width ?? 0) - (grown?.cell?.width ?? 0))).toBeLessThanOrEqual(1);
		expect(after.name.cell?.width ?? 0).toBeGreaterThan(60);
	});

	/**
	 * ⚠ THE CHECKBOX COLUMN IS A SIBLING IN A HORIZONTAL ROW OF FIXED-WIDTH CELLS — the
	 * exact shape of the 420px → 0px incident. So it is measured, not assumed: the name
	 * gives up the box and one gap and nothing more, the reducer is told about the box
	 * (or the number columns keep their slots and the name pays), and the box sits in the
	 * same place in the header and in every row.
	 */
	const checkGeometry = (page: import('@playwright/test').Page) =>
		page.evaluate(() => {
			const rect = (node: Element | null) => {
				if (!node) return null;
				const box = node.getBoundingClientRect();
				const round = (value: number) => Math.round(value * 10) / 10;
				return { left: round(box.left), right: round(box.right), width: round(box.width), height: round(box.height) };
			};
			const body = document.querySelector('[data-pdmux-files-body]') as HTMLElement;
			const head = document.querySelector('[data-pdmux-files-head]') as HTMLElement;
			const item = document.querySelector("[data-pdmux-entry='module-1.ts']") as HTMLElement;
			const row = item.querySelector('.pdmux-files-row') as HTMLElement;
			const cell = item.querySelector('.pdmux-files-check');
			const box = item.querySelector('.pdmux-files-checkbox');
			const hit = (node: Element | null, x: number, y: number) =>
				Boolean(node && document.elementFromPoint(x, y)?.closest('label') === node);
			const cellBox = cell?.getBoundingClientRect();
			return {
				bodyWidth: body.clientWidth,
				bodyOverflow: body.scrollWidth - body.clientWidth,
				rowOverflow: row.scrollWidth - row.clientWidth,
				columns: [...head.querySelectorAll<HTMLElement>('[data-pdmux-cell]')].map((node) => node.dataset.pdmuxCell),
				head: rect(head),
				headCheck: rect(head.querySelector('.pdmux-files-head-check')),
				headBox: rect(head.querySelector('.pdmux-files-checkbox')),
				headIcon: rect(head.querySelector('.pdmux-files-head-icon')),
				headName: rect(head.querySelector('.pdmux-files-cell-name')),
				item: rect(item),
				check: rect(cell),
				box: rect(box),
				button: rect(row),
				icon: rect(row.querySelector('.pdmux-files-icon')),
				name: rect(row.querySelector('.pdmux-files-name')),
				// The label's own corners hit the label: nothing paints over the target.
				cornersHit: cellBox
					? hit(cell, cellBox.left + 1, cellBox.top + 1) && hit(cell, cellBox.right - 1, cellBox.bottom - 1)
					: false,
			};
		});

	for (const width of [420, 390, 260]) {
		test(`[TC-PDUI-231] the checkbox column costs the name a box and a gap at ${width}px`, async ({ page }, testInfo) => {
			await page.goto(`/?screen=files&width=${width}`);
			await page.waitForSelector('[data-pdmux-files-head]');
			const plain = await page.evaluate(() => {
				const row = document.querySelector("[data-pdmux-entry='module-1.ts'] .pdmux-files-row") as HTMLElement;
				return {
					name: Math.round((row.querySelector('.pdmux-files-name') as HTMLElement).getBoundingClientRect().width * 10) / 10,
					columns: [...document.querySelectorAll<HTMLElement>('[data-pdmux-files-head] [data-pdmux-cell]')].map(
						(node) => node.dataset.pdmuxCell,
					),
					boxes: document.querySelectorAll('input[type=checkbox]').length,
				};
			});
			expect(plain.boxes, 'a listing that did not ask for checkboxes draws none').toBe(0);

			await page.goto(`/?screen=files&width=${width}&select=1`);
			await page.waitForSelector('[data-pdmux-files-head]');
			const box = await checkGeometry(page);
			console.log(`TC-PDUI-231 ${width}px plain=${JSON.stringify(plain)} select=${JSON.stringify(box)}`);
			await testInfo.attach(`checkbox-geometry-${width}`, {
				body: JSON.stringify({ plain, select: box }, null, 2),
				contentType: 'application/json',
			});
			await page.screenshot({ path: testInfo.outputPath(`files-checkbox-${width}.png`), animations: 'disabled' });

			// ⚠ THE REDUCER WAS TOLD. The name is what the core budget says it is once the box
			// is charged, to the pixel — not what is left after the number columns took their
			// usual slots.
			const room = fsColumnRoom(box.bodyWidth, true);
			const visible = visibleFsColumns(room, FS_COLUMN_DEFAULTS);
			expect(box.columns).toEqual([...visible]);
			const used = visible.reduce((total, key) => total + FS_COLUMN_DEFAULTS[key] + FS_ROW_GAP, FS_ROW_CHROME + FS_ROW_GAP);
			expect(Math.abs((box.name?.width ?? 0) - (room - used))).toBeLessThanOrEqual(1);
			// Where the same columns fit, the name gave up exactly the box and one gap.
			if (plain.columns.join() === box.columns.join()) {
				expect(Math.abs(plain.name - (box.name?.width ?? 0) - (FS_CHECK_W + FS_ROW_GAP))).toBeLessThanOrEqual(1);
			}
			expect(box.name?.width ?? 0).toBeGreaterThanOrEqual(90);

			// The cell is the box and one gap; the box is the box. The header spends the same.
			expect(Math.abs((box.check?.width ?? 0) - (FS_CHECK_W + FS_ROW_GAP))).toBeLessThanOrEqual(0.5);
			expect(box.box?.width).toBe(FS_CHECK_W);
			expect(box.headBox?.width).toBe(FS_CHECK_W);
			// Header box over row box, header icon over row icon, header name over row name.
			expect(Math.abs((box.headBox?.left ?? 0) - (box.box?.left ?? 0))).toBeLessThanOrEqual(1);
			expect(Math.abs((box.headIcon?.left ?? 0) - (box.icon?.left ?? 0))).toBeLessThanOrEqual(1);
			expect(Math.abs((box.headName?.left ?? 0) - (box.name?.left ?? 0))).toBeLessThanOrEqual(1);
			// No overlap and no clipping: the box ends before the icon starts, the row does not
			// scroll sideways, and the listing does not either.
			expect(box.box?.right ?? 0).toBeLessThanOrEqual(box.icon?.left ?? 0);
			expect(box.box?.left ?? 0).toBeGreaterThanOrEqual(box.item?.left ?? 0);
			expect(box.rowOverflow).toBe(0);
			expect(box.bodyOverflow).toBe(0);
			// The target is the row's full height and nothing covers it.
			expect(Math.abs((box.check?.height ?? 0) - (box.item?.height ?? 0))).toBeLessThanOrEqual(0.5);
			expect(box.cornersHit).toBe(true);
			// The box did not make the row taller than the icon is allowed to.
			expect(box.item?.height ?? 0).toBeLessThanOrEqual(26);
		});
	}

	/**
	 * REPORTED BY THE SUITE, NOT A PERSON: a branch named `agent-terminal-env-window-size` on
	 * the latest commit failed `[TC-PDUI-157]` on a 390px phone. The chip kept its whole name
	 * and the subject — the one column a person reads — was left 39px (`chor…`). Chips now
	 * yield first and each one ends in an ellipsis, with the whole name in its tooltip.
	 */
	const graphGeometry = (page: import('@playwright/test').Page) =>
		page.evaluate(() => {
			const row = document.querySelector('.pdmux-graph-row') as HTMLElement;
			const box = (node: Element | null) => {
				if (!node) return null;
				const rect = node.getBoundingClientRect();
				return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
			};
			return {
				row: box(row),
				subject: box(row.querySelector('.pdmux-graph-subject')),
				chips: box(row.querySelector('.pdmux-graph-chips')),
				date: box(row.querySelector('.pdmux-graph-date')),
				sha: box(row.querySelector('.pdmux-graph-sha')),
				rowSpills: row.scrollWidth > row.clientWidth + 1,
				lanes: Number.parseFloat(getComputedStyle(row).paddingLeft),
				chip: [...row.querySelectorAll<HTMLElement>('.pdmux-graph-chip')].map((chip) => ({
					text: chip.textContent,
					title: chip.getAttribute('title'),
					width: Math.round(chip.getBoundingClientRect().width),
					right: Math.round(chip.getBoundingClientRect().right),
					cut: chip.scrollWidth > chip.clientWidth + 1,
					ellipsis: getComputedStyle(chip).textOverflow,
				})),
			};
		});
	const longBranch = 'a-thirty-character-branch-name';
	const decorated = ['HEAD -> main', 'origin/main', longBranch, 'tag: v1.0.0'];
	const graphUrl = (width: number, refs: readonly string[]) =>
		`/?screen=graph&width=${width}&refs=${encodeURIComponent(refs.join(','))}`;

	test.describe('on a phone', () => {
		test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

		// The branch that failed the suite on its own, the decoration every `main` tip carries,
		// and both together.
		const cases = [[longBranch], ['HEAD -> main', 'origin/main', 'origin/HEAD'], decorated];
		for (const refs of cases) {
			test(`[TC-PDUI-234] ref chips leave the subject readable at 390px (${refs.length} refs)`, async ({ page }, testInfo) => {
				await page.goto(graphUrl(390, refs));
				await page.waitForSelector('.pdmux-graph-row');
				const geometry = await graphGeometry(page);
				console.log(`TC-PDUI-234 390px ${refs.length} refs ${JSON.stringify(geometry)}`);
				await page.screenshot({ path: testInfo.outputPath(`graph-chips-390-${refs.length}.png`), animations: 'disabled' });

				// The bar `[TC-PDUI-157]` sets for the same phone, on the row that failed it.
				expect(geometry.subject?.width ?? 0, 'the subject is what a person reads').toBeGreaterThan(120);
				expect(geometry.chip.length).toBe(refs.length);
				if (refs.includes(longBranch)) {
					const long = geometry.chip.find((chip) => chip.title === longBranch);
					expect(long, 'the long branch keeps its whole name in the tooltip').toBeTruthy();
					expect(long?.cut, 'the long branch is shortened, not given the subject').toBe(true);
					expect(long?.ellipsis).toBe('ellipsis');
				}
				// The checked-out branch keeps its name; the other chips give way first.
				if (refs[0] === 'HEAD -> main') expect(geometry.chip[0]).toMatchObject({ text: 'main', cut: false });
				for (const chip of geometry.chip) {
					expect(chip.title, 'every chip names its ref in full').toBe(chip.text);
					expect(chip.width, `${chip.text} is still a chip`).toBeGreaterThan(0);
				}
				// The chips stay in their own column: nothing runs under the date, and the row
				// does not overflow — it clips, but clipping is the last line of defence.
				expect(geometry.chips?.right ?? 0).toBeLessThanOrEqual((geometry.date?.left ?? 0) + 1);
				expect(geometry.rowSpills).toBe(false);
			});
		}
	});

	test('[TC-PDUI-234] a wide dock shows ordinary refs whole, a narrow one caps them at a quarter', async ({ page }) => {
		const refs = ['HEAD -> main', 'origin/main', 'origin/HEAD'];
		// `DOCK_WIDTH_MAX`: a quarter of the row is room enough for the decoration of a `main` tip.
		await page.goto(graphUrl(900, refs));
		await page.waitForSelector('.pdmux-graph-row');
		const wide = await graphGeometry(page);
		console.log(`TC-PDUI-234 900px ${JSON.stringify(wide)}`);
		expect(wide.chip.map((chip) => chip.text)).toEqual(['main', 'origin/main', 'origin/HEAD']);
		expect(wide.chip.filter((chip) => chip.cut)).toEqual([]);

		// The default dock: a quarter of the row, and the checked-out branch still whole.
		await page.goto(graphUrl(420, refs));
		await page.waitForSelector('.pdmux-graph-row');
		const narrow = await graphGeometry(page);
		console.log(`TC-PDUI-234 420px ${JSON.stringify(narrow)}`);
		expect(narrow.chips?.width ?? 0).toBeLessThanOrEqual(((narrow.row?.width ?? 0) - narrow.lanes) / 4 + 1);
		expect(narrow.chip[0]).toMatchObject({ text: 'main', cut: false });
	});

	test.describe('on a coarse pointer', () => {
		test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

		test('[TC-PDUI-231] a fingertip gets a 32px row, a 32px box target and a 32px header', async ({ page }, testInfo) => {
			await page.goto('/?screen=files&width=390&select=1');
			await page.waitForSelector('[data-pdmux-files-head]');
			expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
			const box = await checkGeometry(page);
			console.log(`TC-PDUI-231 coarse 390px ${JSON.stringify(box)}`);
			await testInfo.attach('checkbox-geometry-coarse-390', {
				body: JSON.stringify(box, null, 2),
				contentType: 'application/json',
			});
			await page.screenshot({ path: testInfo.outputPath('files-checkbox-coarse-390.png'), animations: 'disabled' });
			expect(box.item?.height ?? 0).toBeGreaterThanOrEqual(32);
			expect(box.check?.height ?? 0).toBeGreaterThanOrEqual(32);
			expect(box.button?.height ?? 0).toBeGreaterThanOrEqual(32);
			expect(box.headCheck?.height ?? 0).toBeGreaterThanOrEqual(32);
			// Still aligned, still not crowding the name.
			expect(Math.abs((box.headBox?.left ?? 0) - (box.box?.left ?? 0))).toBeLessThanOrEqual(1);
			expect(box.rowOverflow).toBe(0);
			expect(box.bodyOverflow).toBe(0);

			// A tap on the box toggles it.
			const before = await page.locator("[data-pdmux-check='module-3.ts']").isChecked();
			await page.locator("[data-pdmux-check='module-3.ts']").tap();
			expect(await page.locator("[data-pdmux-check='module-3.ts']").isChecked()).toBe(!before);
		});
	});

	/**
	 * ⚠ AN UNCHECKED BOX IS A CONTROL BOUNDARY, AND WCAG 1.4.11 WANTS 3:1 FOR IT. shadcn's
	 * Checkbox draws it in `--input`, which measured about 1.2:1 on a white row and is 15%
	 * white in the app's dark theme — the box was there for the DOM and missing for the eye.
	 * Measured here against the package's own fallback palette, in both schemes; the app's
	 * palette is measured by the file-transfer harness.
	 *
	 * The colours go through a canvas because the engine is the only thing that knows what
	 * an `oklch()` or a translucent token paints as.
	 */
	const boxContrast = (page: import('@playwright/test').Page, name: string) =>
		page.evaluate(async (entry) => {
			// A colour read mid-transition is neither the old colour nor the new one.
			await Promise.all(document.getAnimations().map((animation) => animation.finished));
			const canvas = document.createElement('canvas');
			canvas.width = 1;
			canvas.height = 1;
			const context = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
			const rgba = (color: string): [number, number, number, number] => {
				context.clearRect(0, 0, 1, 1);
				context.fillStyle = '#000';
				context.fillStyle = color;
				context.fillRect(0, 0, 1, 1);
				const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
				return [r, g, b, a / 255];
			};
			const over = (top: [number, number, number, number], base: [number, number, number]) =>
				[0, 1, 2].map((i) => top[i]! * top[3] + base[i]! * (1 - top[3])) as [number, number, number];
			const backdrop = (node: Element | null): [number, number, number] => {
				const layers: [number, number, number, number][] = [];
				for (let element = node; element; element = element.parentElement) {
					const colour = rgba(getComputedStyle(element).backgroundColor);
					if (colour[3] > 0) layers.push(colour);
					if (colour[3] >= 1) break;
				}
				return layers.reverse().reduce<[number, number, number]>((base, layer) => over(layer, base), [255, 255, 255]);
			};
			const luminance = ([r, g, b]: [number, number, number]) => {
				const channel = (value: number) => {
					const c = value / 255;
					return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
				};
				return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
			};
			const ratio = (a: [number, number, number], b: [number, number, number]) => {
				const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
				return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
			};
			const item = document.querySelector(`[data-pdmux-entry='${entry}']`) as HTMLElement;
			const box = item.querySelector('.pdmux-files-checkbox') as HTMLInputElement;
			const style = getComputedStyle(box);
			const row = backdrop(item);
			const hover = over(rgba(getComputedStyle(item).getPropertyValue('--pdmux-hover')), backdrop(item.parentElement));
			return {
				border: style.borderTopColor,
				ratio: ratio(over(rgba(style.borderTopColor), row), row),
				hoverRatio: ratio(over(rgba(style.borderTopColor), hover), hover),
				borderStyle: style.borderTopStyle,
				opacity: Number(style.opacity),
				cursor: style.cursor,
				labelCursor: getComputedStyle(box.parentElement as HTMLElement).cursor,
				fill: style.backgroundColor,
				title: box.title,
			};
		}, name);

	for (const scheme of ['light', 'dark'] as const) {
		test(`[TC-PDUI-232] an unchecked box clears 3:1 and a disabled one looks disabled, ${scheme}`, async ({ page }, testInfo) => {
			await page.emulateMedia({ colorScheme: scheme });
			await page.goto(`/?screen=files&width=390&select=1&scheme=${scheme}`);
			await page.waitForSelector('[data-pdmux-files-head]');
			const unchecked = await boxContrast(page, 'module-3.ts');
			const disabled = await boxContrast(page, 'node_modules');
			const checked = await boxContrast(page, 'module-1.ts');
			console.log(`TC-PDUI-232 ${scheme} ${JSON.stringify({ unchecked, disabled, checked })}`);
			await testInfo.attach(`checkbox-contrast-${scheme}`, {
				body: JSON.stringify({ unchecked, disabled, checked }, null, 2),
				contentType: 'application/json',
			});
			await page.screenshot({ path: testInfo.outputPath(`files-checkbox-${scheme}.png`), animations: 'disabled' });
			expect(unchecked.ratio).toBeGreaterThanOrEqual(3);
			expect(unchecked.hoverRatio).toBeGreaterThanOrEqual(3);
			expect(unchecked.borderStyle).toBe('solid');
			expect(unchecked.opacity).toBe(1);
			expect(disabled.borderStyle).toBe('dashed');
			expect(disabled.opacity).toBeLessThan(1);
			expect(disabled.cursor).toBe('not-allowed');
			expect(disabled.labelCursor).toBe('not-allowed');
			expect(disabled.title).toBe('Not here');
			expect(disabled.fill).not.toBe(unchecked.fill);
			expect(checked.borderStyle).toBe('solid');
			expect(checked.opacity).toBe(1);
		});
	}

	/**
	 * ⚠ THE PACKAGE FOLLOWS THE APP'S THEME CLASS, NOT ONLY THE OS. Its dark palette used to
	 * sit under `prefers-color-scheme` alone, while the app (mode-watcher, shadcn) switches by
	 * a class on `<html>`. A dark app on a light OS therefore painted the LIGHT code palette —
	 * `#0550ae` folder names — on its dark card, and a light app on a dark OS painted pastel
	 * names on white. The class decides when there is one; the OS decides when there is not.
	 */
	const nameContrast = (page: import('@playwright/test').Page) =>
		page.evaluate(async () => {
			await Promise.all(document.getAnimations().map((animation) => animation.finished));
			const canvas = document.createElement('canvas');
			canvas.width = 1;
			canvas.height = 1;
			const context = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
			const rgba = (color: string): [number, number, number, number] => {
				context.clearRect(0, 0, 1, 1);
				context.fillStyle = '#000';
				context.fillStyle = color;
				context.fillRect(0, 0, 1, 1);
				const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
				return [r, g, b, a / 255];
			};
			const over = (top: [number, number, number, number], base: [number, number, number]) =>
				[0, 1, 2].map((i) => top[i]! * top[3] + base[i]! * (1 - top[3])) as [number, number, number];
			const backdrop = (node: Element | null): [number, number, number] => {
				const layers: [number, number, number, number][] = [];
				for (let element = node; element; element = element.parentElement) {
					const colour = rgba(getComputedStyle(element).backgroundColor);
					if (colour[3] > 0) layers.push(colour);
					if (colour[3] >= 1) break;
				}
				return layers.reverse().reduce<[number, number, number]>((base, layer) => over(layer, base), [255, 255, 255]);
			};
			const luminance = ([r, g, b]: [number, number, number]) => {
				const channel = (value: number) => {
					const c = value / 255;
					return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
				};
				return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
			};
			const ratio = (a: [number, number, number], b: [number, number, number]) => {
				const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
				return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
			};
			const seen = new Set<string>();
			const names: { kind: string; color: string; ratio: number }[] = [];
			for (const item of document.querySelectorAll<HTMLElement>('[data-pdmux-entry]')) {
				const kind = item.dataset.pdmuxFileKind ?? '';
				if (seen.has(kind)) continue;
				seen.add(kind);
				const name = item.querySelector('.pdmux-files-name') as HTMLElement;
				const row = backdrop(item);
				names.push({ kind, color: getComputedStyle(name).color, ratio: ratio(over(rgba(getComputedStyle(name).color), row), row) });
			}
			const card = backdrop(document.querySelector('[data-pdmux-files-body]'));
			return { card: Math.round(luminance(card) * 1000) / 1000, names };
		});

	for (const theme of [
		{ html: 'dark', os: 'light', dark: true },
		{ html: 'light', os: 'dark', dark: false },
		{ html: '', os: 'dark', dark: true },
	] as const) {
		const label = theme.html ? `the app's .${theme.html} class on a ${theme.os} OS` : `no app class on a ${theme.os} OS`;
		test(`[TC-PDUI-233] the palette follows ${label}`, async ({ page }, testInfo) => {
			await page.emulateMedia({ colorScheme: theme.os });
			await page.goto(`/?screen=files&width=390&select=1&scheme=${theme.dark ? 'dark' : 'light'}`);
			await page.waitForSelector('[data-pdmux-files-head]');
			if (theme.html) await page.evaluate((name) => document.documentElement.classList.add(name), theme.html);
			const palette = await nameContrast(page);
			const unchecked = await boxContrast(page, 'module-3.ts');
			const checked = await boxContrast(page, 'module-1.ts');
			const result = { palette, unchecked: unchecked.ratio, checked: checked.ratio, checkedBorder: checked.border };
			console.log(`TC-PDUI-233 ${label} ${JSON.stringify(result)}`);
			await testInfo.attach('theme-contrast', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
			await page.screenshot({ path: testInfo.outputPath(`files-theme-${theme.html || 'none'}-${theme.os}.png`), animations: 'disabled' });

			// The card is the theme's, and every name reads on it.
			if (theme.dark) expect(palette.card).toBeLessThan(0.05);
			else expect(palette.card).toBeGreaterThan(0.8);
			expect(palette.names.length).toBeGreaterThanOrEqual(5);
			for (const name of palette.names) {
				expect(name.ratio, `${name.kind} names (${name.color}) on the row`).toBeGreaterThanOrEqual(4.5);
			}
			// The box keeps its 3:1, unchecked and checked, on the row it sits on.
			expect(unchecked.ratio).toBeGreaterThanOrEqual(3);
			expect(checked.ratio).toBeGreaterThanOrEqual(3);
		});
	}
});
