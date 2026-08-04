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
 * OPT-IN: needs a browser binary. Run `npm run test:geometry -w @pdmux/ui`
 * (which sets PDMUX_BROWSER_TEST=1); without the flag these skip and no server runs.
 */
import { expect, test } from '@playwright/test';

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
});
