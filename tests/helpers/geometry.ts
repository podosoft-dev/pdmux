import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Geometry assertions — "is it actually visible?" rather than "is it in the DOM?".
 *
 * WHY THIS FILE EXISTS: in the tool this product generalises, the same bug report
 * ("clicking a commit shows nothing") was chased three times through caching, the
 * collector and the data model. All three were real bugs; none was the cause. The
 * cause was layout — the page mounted into a host element with no CSS, so it grew
 * to its content height (7,930px measured), the list never became a scroll
 * container and the detail panel rendered ~7,300px below a viewport that clips
 * overflow. Every DOM assertion passed the entire time, because the content really
 * was in the document. It just was not on screen.
 *
 * Playwright's own `toBeVisible()` does not catch this either: an element far
 * below a clipped viewport still has a box and non-zero size. These helpers ask
 * the questions that do catch it.
 */

/** Bounding box + scroll facts for one element, read in the page. */
export interface BoxFacts {
	top: number;
	bottom: number;
	height: number;
	width: number;
	scrollHeight: number;
	clientHeight: number;
	scrollbarWidth: number;
	viewportHeight: number;
}

export async function boxFacts(locator: Locator): Promise<BoxFacts> {
	return locator.evaluate((el: HTMLElement) => {
		const rect = el.getBoundingClientRect();
		return {
			top: Math.round(rect.top),
			bottom: Math.round(rect.bottom),
			height: Math.round(rect.height),
			width: Math.round(rect.width),
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
			scrollbarWidth: el.offsetWidth - el.clientWidth,
			viewportHeight: window.innerHeight,
		};
	});
}

/**
 * The element is inside the viewport AND a real pointer landing on it hits the
 * element (or a descendant) — nothing covers it, nothing clipped it away.
 *
 * The hit test is the part that matters: an element can be inside the viewport and
 * still be unreachable behind an overlay, which is a different bug with the same
 * symptom.
 */
export async function expectOnScreen(locator: Locator, label = "element"): Promise<void> {
	const facts = await boxFacts(locator);
	expect(facts.height, `${label}: has no height`).toBeGreaterThan(0);
	expect(facts.top, `${label}: starts above the viewport`).toBeGreaterThanOrEqual(0);
	expect(
		facts.bottom,
		`${label}: bottom ${facts.bottom}px is below the ${facts.viewportHeight}px viewport`,
	).toBeLessThanOrEqual(facts.viewportHeight + 1);

	const hit = await locator.evaluate((el: HTMLElement) => {
		const rect = el.getBoundingClientRect();
		const point = document.elementFromPoint(
			Math.round(rect.left + rect.width / 2),
			Math.round(rect.top + Math.min(12, rect.height / 2)),
		);
		return Boolean(point && (point === el || el.contains(point)));
	});
	expect(hit, `${label}: a pointer at its centre does not reach it`).toBe(true);
}

/**
 * The element is a scroll container that can actually move, and its scrollbar
 * takes space.
 *
 * The width check is deliberate: overlay scrollbars (the macOS default) give no
 * hint that a 300-row list continues below the fold, which is why the layout
 * reserves the gutter.
 */
export async function expectScrollable(locator: Locator, label = "list"): Promise<void> {
	const facts = await boxFacts(locator);
	expect(
		facts.scrollHeight,
		`${label}: content (${facts.scrollHeight}px) does not exceed the box (${facts.clientHeight}px) — the fixture is too short to prove scrolling`,
	).toBeGreaterThan(facts.clientHeight + 1);
	expect(facts.scrollbarWidth, `${label}: scrollbar takes no space`).toBeGreaterThan(0);

	const moved = await locator.evaluate((el: HTMLElement) => {
		const before = el.scrollTop;
		el.scrollTop = el.scrollHeight;
		const after = el.scrollTop;
		el.scrollTop = before;
		return after;
	});
	expect(moved, `${label}: scrolling does not move it`).toBeGreaterThan(0);
}

/**
 * The page itself never scrolls: the shell is bound to the viewport and each pane
 * owns its own scrolling. A scrolling document is the signature of the layout bug
 * described at the top of this file.
 */
export async function expectViewportBound(page: Page): Promise<void> {
	const scrolls = await page.evaluate(() => {
		const el = document.scrollingElement ?? document.documentElement;
		return el.scrollHeight > el.clientHeight + 1;
	});
	expect(scrolls, "the page scrolls — the layout is not bound to the viewport").toBe(false);
}
