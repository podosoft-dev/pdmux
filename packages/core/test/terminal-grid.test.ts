/**
 * Terminal grid reducers. Ported from the dashboard this package generalises, whose
 * suite is the behavioural spec: every case here locks a rule that was learned from
 * a real defect, not an invented invariant.
 */
import { describe, expect, it } from 'vitest';
import {
	FILES_SHARE_MAX,
	FILES_SHARE_MIN,
	setFilesShare,
	setFilesTarget,
	GRID_COLUMNS,
	GRID_SIZE,
	type GridCell,
	type GridHost,
	type TerminalLayout,
	assignSlot,
	buildDefaultSlots,
	clearDockDetailHeight,
	clearSlot,
	cycleMode,
	defaultLayout,
	dropTargetIndex,
	emptyCellKind,
	firstEmptyIndex,
	focusSlot,
	guardIntent,
	isSlotReachable,
	movePage,
	nextSessionName,
	nextSlotId,
	normalizeLayout,
	orphanPaneIds,
	pageCount,
	pickerApply,
	removeSlot,
	setClickAction,
	setDockDetailHeight,
	setDockTarget,
	soloIndex,
	soloLayout,
	soloStep,
	setDockWidth,
	setSidebarWidth,
	shouldDetachAll,
	slotLabel,
	stalePaneIds,
	starterCells,
	swapSlots,
	toProtocolTarget,
	toggleDock,
	toggleFiles,
	toggleDockRefs,
	toggleSidebar,
	toggleZoom,
	visibleIndexes,
	visibleSlots,
} from '../src/index.js';

const HOSTS: GridHost[] = [
	{
		id: 'h1',
		name: 'alpha',
		online: true,
		sessions: [
			{ name: 'main', attached: 1, windows: 3 },
			{ name: 'agent-main', attached: 1, windows: 1 },
		],
	},
	{ id: 'h2', name: 'beta', online: true, sessions: [{ name: 'main', attached: 0, windows: 1 }] },
	{ id: 'h3', name: 'gamma', online: false, sessions: [] },
];

const hostName = (id: string): string => HOSTS.find((h) => h.id === id)?.name ?? id;
const labels = (slots: readonly GridCell[]): Array<string | null> =>
	slots.map((s) => (s ? slotLabel(s, hostName(s.hostId)) : null));

/** A layout with the default arrangement (7 filled cells for HOSTS with pad 2). */
const layout = (over: Partial<TerminalLayout> = {}): TerminalLayout => ({
	...defaultLayout(),
	slots: buildDefaultSlots(HOSTS, { pad: 2 }),
	...over,
});

describe('[TC-PDCORE-001] the visible window is always the size of the active mode', () => {
	it('renders the page window, padding a short page with empty cells', () => {
		expect(GRID_SIZE).toEqual({ tab: 1, split2: 2, split4: 4, split9: 9 });
		expect(GRID_COLUMNS).toEqual({ tab: 1, split2: 2, split4: 2, split9: 3 });
		expect(labels(visibleSlots(layout()))).toEqual(['alpha·main', 'alpha·agent-main', 'alpha·w1', 'alpha·w2']);
		// A short last page keeps its cells: leftovers are empty, never filled from
		// the next page — that is what makes the layout stable when a pane closes.
		expect(labels(visibleSlots(layout({ page: 1 })))).toEqual(['beta·main', 'beta·w1', 'beta·w2', null]);
		expect(visibleIndexes(layout({ page: 1 }))).toEqual([4, 5, 6, 7]);
		expect(visibleSlots(layout({ slots: [], mode: 'split9' }))).toHaveLength(9);
		expect(visibleSlots(layout({ slots: [] }))).toEqual([null, null, null, null]);
	});

	it('zooms to exactly one cell and reports that cell index', () => {
		const base = layout({ mode: 'split4', page: 1 });
		const zoomed = toggleZoom(base, base.slots[5]!.id);
		expect(labels(visibleSlots(zoomed))).toEqual(['beta·w1']);
		expect(visibleIndexes(zoomed)).toEqual([5]);
	});
});

describe('[TC-PDCORE-002] paging offers one spare page so more terminals can be composed', () => {
	it('counts pages and adds a spare only when the last page is full', () => {
		expect(pageCount(layout())).toBe(2);
		expect(pageCount(layout({ mode: 'split9' }))).toBe(1);
		expect(pageCount(layout({ mode: 'tab' }))).toBe(8); // 7 full pages + one spare
		expect(pageCount(layout({ slots: [] }))).toBe(1); // an empty grid never grows
		const eight = layout({ slots: [...buildDefaultSlots(HOSTS, { pad: 2 }), null] });
		expect(pageCount(layout({ slots: eight.slots.filter(Boolean).concat(eight.slots[0]!) }))).toBe(3);
	});
});

describe('[TC-PDCORE-003] the mode buttons walk the fleet without losing the anchor', () => {
	it('re-pressing the active mode advances a page and wraps', () => {
		let state = layout({ mode: 'split4', page: 0 });
		state = cycleMode(state, 'split4');
		expect(state.page).toBe(1);
		state = cycleMode(state, 'split4');
		expect(state.page).toBe(0);
	});

	it('switching mode keeps the anchor terminal visible and always leaves zoom', () => {
		const base = layout({ mode: 'split4', page: 1 }); // shows slots[4..7]
		const two = cycleMode(base, 'split2');
		expect(two.mode).toBe('split2');
		expect(two.page).toBe(2); // floor(4 / 2)
		expect(visibleSlots(two)[0]!.id).toBe(base.slots[4]!.id);
		// A focused slot wins as the anchor over the first visible one.
		const focused = focusSlot({ ...base, page: 0 }, base.slots[3]!.id);
		expect(cycleMode(focused, 'tab').page).toBe(3);
		const zoomed = toggleZoom(base, base.slots[5]!.id);
		expect(cycleMode(zoomed, 'split9').zoomId).toBeNull();
		expect(cycleMode(zoomed, 'split4').zoomId).toBeNull();
		expect(cycleMode(base, 'nonsense' as never)).toBe(base);
	});
});

describe('[TC-PDCORE-004] the pager wraps in both directions and clamps a stored page', () => {
	it('steps, wraps and survives an out-of-range page', () => {
		expect(movePage(layout({ page: 0 }), +1).page).toBe(1);
		expect(movePage(layout({ page: 1 }), +1).page).toBe(0);
		expect(movePage(layout({ page: 0 }), -1).page).toBe(1);
		expect(movePage(layout({ page: 0 }), Number.NaN).page).toBe(0);
		expect(labels(visibleSlots(layout({ page: 99 })))).toEqual(labels(visibleSlots(layout({ page: 1 }))));
	});
});

describe('[TC-PDCORE-005] zoom is a toggle whose exit restores the exact mode and page', () => {
	it('keeps mode/page untouched while zoomed', () => {
		const base = layout({ mode: 'split4', page: 1 });
		const zoomed = toggleZoom(base, base.slots[5]!.id);
		expect(zoomed.zoomId).toBe(base.slots[5]!.id);
		expect([zoomed.mode, zoomed.page]).toEqual(['split4', 1]);
		const restored = toggleZoom(zoomed, base.slots[5]!.id);
		expect(restored.zoomId).toBeNull();
		expect(labels(visibleSlots(restored))).toEqual(labels(visibleSlots(base)));
		// A different id moves the zoom; an empty cell has nothing to zoom.
		expect(toggleZoom(zoomed, base.slots[4]!.id).zoomId).toBe(base.slots[4]!.id);
		expect(toggleZoom(base, null)).toBe(base);
	});
});

describe('[TC-PDCORE-006] assignSlot fills one cell in place', () => {
	it('never disturbs a neighbour and grows the grid with empty cells', () => {
		const base = layout();
		const next = assignSlot(base, 1, { hostId: 'h2', kind: 'shell' });
		expect(slotLabel(next.slots[1]!, 'beta')).toBe('beta·shell');
		expect(next.slots[1]!.session).toBeNull();
		expect(labels(next.slots).filter((_, i) => i !== 1)).toEqual(labels(base.slots).filter((_, i) => i !== 1));
		expect([next.mode, next.page]).toEqual([base.mode, base.page]);
		const grown = assignSlot(base, 9, { hostId: 'h2', kind: 'shell' });
		expect(grown.slots).toHaveLength(10);
		expect(grown.slots[8]).toBeNull();
		// Junk cannot corrupt the grid.
		expect(assignSlot(base, -1, { hostId: 'h1', kind: 'attach' })).toBe(base);
		expect(assignSlot(base, 1.5, { hostId: 'h1', kind: 'attach' })).toBe(base);
	});
});

describe('[TC-PDCORE-007] closing a terminal leaves its cell EMPTY', () => {
	it('does not re-index, and drops a zoom or focus that pointed at it', () => {
		// The regression this model exists for: with a plain list, removing a pane
		// pulled the following terminal into the freed cell, so closing looked like
		// opening a new window.
		const base = layout();
		const cleared = clearSlot(base, 1);
		expect(cleared.slots).toHaveLength(base.slots.length);
		expect(cleared.slots[1]).toBeNull();
		expect(labels(cleared.slots)[2]).toBe(labels(base.slots)[2]);
		expect(labels(visibleSlots(cleared))).toEqual(['alpha·main', null, 'alpha·w1', 'alpha·w2']);
		const zoomed = toggleZoom(base, base.slots[0]!.id);
		const gone = clearSlot(zoomed, 0);
		expect([gone.zoomId, gone.focusId]).toEqual([null, null]);
		expect(clearSlot(cleared, 1)).toBe(cleared); // already empty -> no-op
	});
});

describe('[TC-PDCORE-008] emptyCellKind separates a real hole from window padding', () => {
	it('classifies every index', () => {
		const base = layout();
		const holed = clearSlot(base, 2);
		expect(emptyCellKind(holed, 2)).toBe('hole');
		expect(emptyCellKind(holed, 0)).toBeNull();
		// slots never end with null (closing trims), so anything at/after the end is padding.
		expect(emptyCellKind(base, base.slots.length)).toBe('padding');
		expect(emptyCellKind(base, base.slots.length + 3)).toBe('padding');
		expect(emptyCellKind(layout({ slots: [] }), 0)).toBe('padding');
	});
});

describe('[TC-PDCORE-009] closing an EMPTY cell pulls the following panes forward', () => {
	it('splices holes only, and clamps a page that no longer exists', () => {
		const base = layout();
		const holed = clearSlot(base, 1);
		const closed = removeSlot(holed, 1);
		expect(closed.slots).toHaveLength(holed.slots.length - 1);
		expect(labels(closed.slots)).toEqual(labels(base.slots).filter((_, i) => i !== 1));
		expect(closed.slots.includes(null)).toBe(false);
		// A filled cell is not removed this way, and padding has nothing to pull.
		expect(removeSlot(base, 1)).toBe(base);
		expect(removeSlot(base, base.slots.length)).toBe(base);
		expect(removeSlot(base, 99)).toBe(base);
		// Zoom survives because it references a slot id, not a position.
		const zoomed = toggleZoom(clearSlot(base, 1), base.slots[3]!.id);
		const after = removeSlot(zoomed, 1);
		expect(after.zoomId).toBe(base.slots[3]!.id);
		// 8 cells in 4-up are pages 0-2 (the last is the spare); at 7 only 0-1 remain.
		const eight = layout({ slots: [...buildDefaultSlots(HOSTS, { pad: 2 }), base.slots[0] ?? null] });
		expect(pageCount(eight)).toBe(3);
		expect(removeSlot({ ...clearSlot(eight, 1), page: 2 }, 1).page).toBe(1);
	});
});

describe('[TC-PDCORE-010] dragging a header swaps two cells', () => {
	it('moves onto an empty cell and keeps the zoom with the terminal', () => {
		const base = layout();
		const swapped = swapSlots(base, 0, 2);
		expect(labels(swapped.slots)[0]).toBe(labels(base.slots)[2]);
		expect(labels(swapped.slots)[2]).toBe(labels(base.slots)[0]);
		expect(labels(swapped.slots).filter((_, i) => i !== 0 && i !== 2)).toEqual(
			labels(base.slots).filter((_, i) => i !== 0 && i !== 2),
		);
		const moved = swapSlots(clearSlot(base, 3), 0, 3);
		expect(labels(moved.slots)[3]).toBe(labels(base.slots)[0]);
		expect(moved.slots[0]).toBeNull();
		// Onto padding: the grid grows, then trailing empties trim.
		const padded = swapSlots(base, 0, base.slots.length + 1);
		expect(labels(padded.slots).at(-1)).toBe(labels(base.slots)[0]);
		expect(swapSlots(base, 2, 2)).toBe(base);
		expect(swapSlots(base, -1, 2)).toBe(base);
		const zoomed = toggleZoom(base, base.slots[0]!.id);
		expect(swapSlots(zoomed, 0, 2).zoomId).toBe(base.slots[0]!.id);
	});
});

describe('[TC-PDCORE-011] the picker writes into the cell it was opened from', () => {
	it('falls back to the first empty cell when opened without one', () => {
		const base = layout();
		const target = { hostId: 'h2', kind: 'shell' } as const;
		const retargeted = pickerApply(base, 1, target);
		expect(retargeted.slots).toHaveLength(base.slots.length);
		expect(labels(retargeted.slots)[1]).toBe('beta·shell');
		const appended = pickerApply(base, null, target);
		expect(appended.slots).toHaveLength(base.slots.length + 1);
		expect(labels(appended.slots).at(-1)).toBe('beta·shell');
		const holed = clearSlot(base, 2);
		const reused = pickerApply(holed, null, target);
		expect(reused.slots).toHaveLength(holed.slots.length);
		expect(labels(reused.slots)[2]).toBe('beta·shell');
	});
});

describe('[TC-PDCORE-012] firstEmptyIndex finds where a new terminal should land', () => {
	it('prefers the lowest hole, else one past the end', () => {
		const base = layout();
		expect(firstEmptyIndex(base)).toBe(base.slots.length);
		expect(firstEmptyIndex(clearSlot(base, 2))).toBe(2);
		expect(firstEmptyIndex(layout({ slots: [] }))).toBe(0);
		expect(firstEmptyIndex(clearSlot(clearSlot(base, 5), 1))).toBe(1);
	});
});

describe('[TC-PDCORE-013] the default arrangement is online hosts, main first, then padding', () => {
	it('orders by host name and pads with new sessions', () => {
		const slots = buildDefaultSlots(HOSTS, { pad: 2 });
		expect(labels(slots)).toEqual([
			'alpha·main',
			'alpha·agent-main',
			'alpha·w1',
			'alpha·w2',
			'beta·main',
			'beta·w1',
			'beta·w2',
		]);
		expect(slots.map((s) => s!.kind)).toEqual(['attach', 'attach', 'new', 'new', 'attach', 'new', 'new']);
		expect(slots.some((s) => s!.hostId === 'h3')).toBe(false); // offline host excluded
		expect(new Set(slots.map((s) => s!.id)).size).toBe(slots.length);
		expect(buildDefaultSlots([], { pad: 2 })).toEqual([]);
		expect(buildDefaultSlots([HOSTS[2]!], { pad: 2 })).toEqual([]);
	});

	it('keeps long-running service sessions out of the default arrangement', () => {
		// They are servers, not work surfaces — twenty of them would bury the
		// interactive sessions. They stay fully pickable.
		const hosts: GridHost[] = [
			{
				id: 'x',
				name: 'x',
				online: true,
				sessions: [
					{ name: 'main' },
					{ name: 'dev-api' },
					{ name: 'agent-1' },
					{ name: 'dev-web' },
				],
			},
		];
		const filtered = buildDefaultSlots(hosts, { pad: 1, excludePrefix: 'dev-' });
		expect(filtered.map((s) => s!.session)).toEqual(['main', 'agent-1', 'w1']);
		expect(buildDefaultSlots(hosts, { pad: 0 })).toHaveLength(4); // no prefix = everything
		expect(buildDefaultSlots(hosts, { pad: 0, excludePrefix: 'agent-' }).map((s) => s!.session)).toEqual([
			'main',
			'dev-api',
			'dev-web',
		]);
	});
});

describe('[TC-PDCORE-086] a first visit opens four cells and joins at most one session', () => {
	it('attaches the first cell to the first reachable host main and leaves the rest empty', () => {
		const cells = starterCells(HOSTS);
		// Four, not "one per live session per host": the full arrangement filled ~33 pages
		// on a real fleet and exhausted the agent's PTY cap, which printed "terminal limit
		// reached" into the panes instead of a dashboard.
		expect(cells).toHaveLength(4);
		expect(labels(cells)).toEqual(['alpha·main', null, null, null]);
		expect(cells[0]).toEqual({ id: 's1', hostId: 'h1', kind: 'attach', session: 'main' });
	});

	it('leaves the first cell empty rather than joining somebody else session', () => {
		// A live session belongs to whoever is working in it — auto-attaching to whatever
		// happened to be running has already typed into a running agent here. `main` is the
		// only name this tool owns by convention; anything else stays assignable.
		const hosts: GridHost[] = [
			{ id: 'x', name: 'x', online: true, sessions: [{ name: 'agent-7' }, { name: 'w1' }] },
		];
		expect(starterCells(hosts)).toEqual([null, null, null, null]);
		expect(labels(starterCells(HOSTS, { prefer: 'agent-main' }))).toEqual(['alpha·agent-main', null, null, null]);
	});

	it('never creates a session and still fills the window with no reachable host', () => {
		expect(starterCells([])).toEqual([null, null, null, null]);
		expect(starterCells([HOSTS[2]!])).toEqual([null, null, null, null]); // offline host
		// No `new` cell anywhere: creating sessions on somebody's machine is the user's
		// call, made per cell, not a side effect of opening the page.
		expect(starterCells(HOSTS).some((cell) => cell?.kind === 'new')).toBe(false);
		const nine = starterCells(HOSTS, { count: 9 });
		expect(nine).toHaveLength(9);
		expect(nine.slice(1).every((cell) => cell === null)).toBe(true);
	});

	it('does not mutate the fleet it is handed', () => {
		// It runs on the array the fleet feed owns and re-renders from, so an in-place sort
		// would reorder the host sidebar as a side effect of painting the grid.
		const hosts: GridHost[] = [...HOSTS];
		const before = JSON.stringify(hosts);
		starterCells(hosts);
		expect(hosts.map((h) => h.id)).toEqual(['h1', 'h2', 'h3']);
		expect(JSON.stringify(hosts)).toBe(before);
	});
});

describe('[TC-PDCORE-014] a generated session name never collides with a live one', () => {
	it('picks the lowest free w<N>', () => {
		const hosts: GridHost[] = [{ id: 'm', name: 'm', online: true, sessions: [{ name: 'w1' }] }];
		expect(labels(buildDefaultSlots(hosts, { pad: 2 }))).toEqual(['m·w1', 'm·w2', 'm·w3']);
		expect(nextSessionName(hosts, 'm')).toBe('w2');
		expect(nextSessionName(hosts, 'm', ['w2'])).toBe('w3');
		expect(nextSessionName(HOSTS, 'h1')).toBe('w1');
		expect(nextSessionName(HOSTS, 'missing')).toBe('w1');
	});
});

describe('[TC-PDCORE-015] a restored layout never mints an id that already exists', () => {
	it('derives the next id from the layout, and repairs a stored duplicate', () => {
		// The id counter used to restart on every page load while ids came back from
		// storage, so the next assignment re-issued an existing id, two cells resolved
		// to the SAME pane and the terminal appeared in the wrong cell.
		const stored = {
			slots: [
				{ id: 's1', hostId: 'h1', kind: 'attach', session: 'main' },
				{ id: 's2', hostId: 'h1', kind: 'attach', session: 'agent-main' },
			],
		};
		const hydrated = normalizeLayout(stored, HOSTS);
		expect(hydrated.slots.map((s) => s!.id)).toEqual(['s1', 's2']);
		const grown = assignSlot(hydrated, 2, { hostId: 'h1', kind: 'shell' });
		const ids = grown.slots.filter(Boolean).map((s) => s!.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(['s1', 's2']).not.toContain(grown.slots[2]!.id);
		expect(nextSlotId([])).toBe('s1');
		expect(nextSlotId(grown.slots)).toBe('s4');

		const repaired = normalizeLayout(
			{ slots: [...stored.slots, { id: 's1', hostId: 'h2', kind: 'attach', session: 'main' }] },
			HOSTS,
		);
		const repairedIds = repaired.slots.filter(Boolean).map((s) => s!.id);
		expect(new Set(repairedIds).size).toBe(repairedIds.length);
		expect(repaired.slots).toHaveLength(3); // cell count and positions are kept
	});
});

describe('[TC-PDCORE-016] hydration repairs junk and drops slots of vanished hosts', () => {
	it('starts empty on a first visit', () => {
		const fresh = normalizeLayout(null, HOSTS);
		expect(fresh.mode).toBe('split4');
		expect(fresh.slots).toEqual([]);
		expect(fresh.sidebarOpen).toBe(true);
		expect(fresh.clickAction).toBe('zoom');
	});

	it('repairs every field and keeps the user positions', () => {
		const repaired = normalizeLayout({ mode: 'nonsense', page: -5, zoomId: 'ghost', slots: 'nope' }, HOSTS);
		expect(repaired.mode in GRID_SIZE).toBe(true);
		expect(repaired.page).toBe(0);
		expect(repaired.zoomId).toBeNull();
		expect(repaired.slots).toEqual([]);

		// An offline host keeps its slot (it works again when the host boots); a host
		// that no longer exists leaves an EMPTY cell instead of shifting the layout.
		const kept = normalizeLayout(
			{
				mode: 'split2',
				slots: [
					{ id: 'a', hostId: 'h3', kind: 'attach', session: 'main' },
					null,
					{ id: 'b', hostId: 'removed', kind: 'attach', session: 'main' },
					{ id: 'c', hostId: 'h2', kind: 'attach', session: 'main' },
				],
			},
			HOSTS,
		);
		expect(kept.slots.map((s) => s?.id ?? null)).toEqual(['a', null, null, 'c']);
		const trimmed = normalizeLayout(
			{ slots: [{ id: 'a', hostId: 'h1', kind: 'attach', session: 'main' }, null, null] },
			HOSTS,
		);
		expect(trimmed.slots.map((s) => s?.id ?? null)).toEqual(['a']);
	});
});

describe('[TC-PDCORE-087] an unreadable fleet never reads as a deleted one', () => {
	const saved = {
		mode: 'split4',
		focusId: 'a',
		zoomId: 'a',
		slots: [
			{ id: 'a', hostId: 'h1', kind: 'attach', session: 'claude-1' },
			{ id: 'b', hostId: 'h2', kind: 'attach', session: 'claude-2' },
		],
	};

	it('keeps every slot when the host list could not be read', () => {
		// `GET /api/hosts` failed and the loader fell back to `[]`. Dropping the slots
		// here empties the grid, and the next interaction saves that — the layout is
		// gone with no undo. Regression: it happened twice on 2026-07-27.
		const outage = normalizeLayout(saved, [], { fleetKnown: false });
		expect(outage.slots.map((s) => s?.id ?? null)).toEqual(['a', 'b']);
		expect(outage.slots.map((s) => s?.session ?? null)).toEqual(['claude-1', 'claude-2']);
		// The selection survives too, so nothing re-mounts when the fleet comes back.
		expect([outage.focusId, outage.zoomId]).toEqual(['a', 'a']);
	});

	it('still drops a genuinely deleted host, and defaults to doing so', () => {
		// The fleet was read and h2 is not in it: that IS a deletion, so its cell empties
		// while the surviving slot keeps its id.
		const pruned = normalizeLayout(saved, HOSTS.filter((h) => h.id === 'h1'), { fleetKnown: true });
		expect(pruned.slots.map((s) => s?.id ?? null)).toEqual(['a']);
		// Callers that say nothing get the strict reading — the option only ever relaxes
		// it for a caller that knows it is guessing.
		expect(normalizeLayout(saved, []).slots).toEqual([]);
		expect(normalizeLayout(saved, [], {}).slots).toEqual([]);
	});
});

describe('[TC-PDCORE-017] shell reducers clamp to usable ranges', () => {
	it('toggles the sidebar, the click mode and the widths without touching terminals', () => {
		const base = layout();
		expect(toggleSidebar(base).sidebarOpen).toBe(false);
		expect(toggleSidebar(toggleSidebar(base)).sidebarOpen).toBe(true);
		expect(setClickAction(base, 'focus').clickAction).toBe('focus');
		expect(setClickAction(base, 'bogus').clickAction).toBe('zoom');
		expect(setSidebarWidth(base, 420).sidebarWidth).toBe(420);
		expect(setSidebarWidth(base, 9999).sidebarWidth).toBe(720);
		expect(setSidebarWidth(base, 0).sidebarWidth).toBe(180);
		expect(setSidebarWidth(base, Number.NaN).sidebarWidth).toBe(base.sidebarWidth);
		for (const next of [toggleSidebar(base), setClickAction(base, 'focus'), setSidebarWidth(base, 400)]) {
			expect([next.mode, next.page]).toEqual([base.mode, base.page]);
			expect(labels(next.slots)).toEqual(labels(base.slots));
		}
		const hydrated = normalizeLayout({ sidebarWidth: 5000, sidebarOpen: 'yes', clickAction: 'nonsense' }, HOSTS);
		expect(hydrated.sidebarWidth).toBe(720);
		expect(hydrated.sidebarOpen).toBe(true);
		expect(hydrated.clickAction).toBe('zoom');
		expect(normalizeLayout({ sidebarWidth: 10 }, HOSTS).sidebarWidth).toBe(180);
		expect(normalizeLayout({ clickAction: 'focus' }, HOSTS).clickAction).toBe('focus');
	});
});

describe('[TC-PDCORE-018] the click guard tells a click from a drag', () => {
	it('keeps text selection possible inside a split pane', () => {
		// A terminal surface hides its own clicks, so an overlay is the only way to
		// offer click-to-zoom — but it must let a drag through, or nothing can be
		// selected (and therefore copied) inside a split pane.
		expect(guardIntent({ x: 100, y: 100, t: 0 }, { x: 102, y: 101, t: 120 })).toBe('click');
		expect(guardIntent({ x: 100, y: 100, t: 0 }, { x: 260, y: 140, t: 300 })).toBe('drag');
		expect(guardIntent({ x: 100, y: 100, t: 0 }, { x: 100, y: 100, t: 900 })).toBe('drag');
		// Boundaries: 4/4px apart is 5.66 (inside the 6px slop) and 399ms is inside 400ms.
		expect(guardIntent({ x: 100, y: 100, t: 0 }, { x: 104, y: 104, t: 399 })).toBe('click');
		expect(guardIntent({ x: 100, y: 100, t: 0 }, { x: 105, y: 105, t: 100 })).toBe('drag');
	});
});

describe('[TC-PDCORE-019] a drop target is resolved from the cells rects', () => {
	it('hit-tests by pointer position, with boundaries in exactly one cell', () => {
		const rects = [
			{ index: 4, rect: { left: 0, top: 0, right: 100, bottom: 50 } },
			{ index: 5, rect: { left: 100, top: 0, right: 200, bottom: 50 } },
			{ index: 6, rect: { left: 0, top: 50, right: 100, bottom: 100 } },
		];
		expect(dropTargetIndex(rects, { x: 50, y: 25 })).toBe(4);
		expect(dropTargetIndex(rects, { x: 150, y: 10 })).toBe(5);
		expect(dropTargetIndex(rects, { x: 10, y: 75 })).toBe(6);
		expect(dropTargetIndex(rects, { x: 100, y: 25 })).toBe(5);
		expect(dropTargetIndex(rects, { x: 300, y: 25 })).toBeNull();
		expect(dropTargetIndex([], { x: 1, y: 1 })).toBeNull();
	});
});

describe('[TC-PDCORE-085] a narrow screen renders one pane without rewriting the layout', () => {
	const hosts: GridHost[] = [{ id: 'h1', name: 'one', online: true, sessions: [{ name: 'a' }, { name: 'b' }] }];

	it('projects a single cell and leaves the stored split alone', () => {
		let state = normalizeLayout({ mode: 'split9' }, hosts);
		state = pickerApply(state, 0, { hostId: 'h1', kind: 'attach', session: 'a' });
		state = pickerApply(state, 1, { hostId: 'h1', kind: 'attach', session: 'b' });

		const solo = soloLayout(state, 1);
		expect(solo.mode).toBe('tab');
		// Page N IS cell N with a window of one, so every callback still addresses the real
		// cell — no translation layer to get wrong.
		expect(visibleIndexes(solo)).toEqual([1]);
		expect(visibleSlots(solo).map((slot) => slot?.session ?? null)).toEqual(['b']);

		// THE POINT: `mode` is the user's desktop split, persisted per user and shared
		// across devices. A phone that wrote `tab` into it would silently reduce everyone's
		// desktop to one terminal.
		expect(state.mode).toBe('split9');
		expect(soloLayout(state, 1)).not.toBe(state);
		expect(state.page).toBe(0);
	});

	it('anchors on where the user is, and steps with wrapping', () => {
		let state = normalizeLayout({ mode: 'split4' }, hosts);
		state = pickerApply(state, 0, { hostId: 'h1', kind: 'attach', session: 'a' });
		state = pickerApply(state, 1, { hostId: 'h1', kind: 'attach', session: 'b' });

		// Focus wins, so the phone opens on the pane the desktop left focused.
		const focused = focusSlot(state, state.slots[1]?.id ?? null);
		expect(soloIndex(focused)).toBe(1);
		expect(soloIndex(state)).toBe(0);

		// Two cells plus the one spare empty cell — which is how a phone reaches "add a
		// terminal" with the same pager the desktop uses.
		expect(soloStep(state, 0, 1)).toBe(1);
		expect(soloStep(state, 1, 1)).toBe(2);
		expect(soloStep(state, 2, 1)).toBe(0);
		expect(soloStep(state, 0, -1)).toBe(2);

		// Junk cannot move the cursor off the grid.
		expect(soloStep(state, 0, Number.NaN)).toBe(0);
		expect(soloLayout(state, -5).page).toBe(0);
		expect(soloLayout(state, 99).page).toBe(state.slots.length);
	});
});

describe('[TC-PDCORE-020] the commit dock is a toggle with a clamped width and a stored target', () => {
	it('round-trips through persistence and repairs junk', () => {
		let state = normalizeLayout(null, []);
		expect([state.dockOpen, state.dockWidth, state.dockTarget]).toEqual([false, 420, null]);
		state = toggleDock(state);
		expect(state.dockOpen).toBe(true);
		expect(toggleDock(state).dockOpen).toBe(false);
		expect(setDockWidth(state, 10).dockWidth).toBe(260);
		expect(setDockWidth(state, 99999).dockWidth).toBe(900);
		expect(setDockWidth(state, 512.4).dockWidth).toBe(512);
		expect(setDockWidth(state, Number.NaN).dockWidth).toBe(state.dockWidth);
		state = setDockTarget(state, { hostId: 'h1', repo: 'api' });
		expect(state.dockTarget).toEqual({ hostId: 'h1', repo: 'api' });
		expect(setDockTarget(state, { repo: 'x' }).dockTarget).toBeNull();
		const reloaded = normalizeLayout(JSON.parse(JSON.stringify(state)), []);
		expect(reloaded.dockOpen).toBe(true);
		expect(reloaded.dockTarget).toEqual({ hostId: 'h1', repo: 'api' });
		const dirty = normalizeLayout({ dockOpen: 'yes', dockWidth: 'wide', dockTarget: { hostId: 7 } }, []);
		expect([dirty.dockOpen, dirty.dockWidth, dirty.dockTarget]).toEqual([false, 420, null]);
	});

	it('[TC-PDCORE-082] sizes the commit detail, starting from content height', () => {
		const state = normalizeLayout(null, []);
		// Null, not a number: a fixed default would pad a one-line commit message with
		// empty space before the user has expressed any preference.
		expect(state.dockDetailHeight).toBeNull();

		expect(setDockDetailHeight(state, 40).dockDetailHeight).toBe(120);
		expect(setDockDetailHeight(state, 5000).dockDetailHeight).toBe(900);
		expect(setDockDetailHeight(state, 317.6).dockDetailHeight).toBe(318);
		// A gesture that produced no number must not write NaN into the stored layout.
		expect(setDockDetailHeight(state, Number.NaN).dockDetailHeight).toBeNull();

		const sized = setDockDetailHeight(state, 300);
		expect(clearDockDetailHeight(sized).dockDetailHeight).toBeNull();
		expect(normalizeLayout(JSON.parse(JSON.stringify(sized)), []).dockDetailHeight).toBe(300);
		// Out-of-range and junk values are repaired on the way in, like every other px.
		expect(normalizeLayout({ dockDetailHeight: 9999 }, []).dockDetailHeight).toBe(900);
		expect(normalizeLayout({ dockDetailHeight: 'tall' }, []).dockDetailHeight).toBeNull();
	});

	it('remembers whether the refs panel is open', () => {
		// Off by default: at 420px the panel would take a third of the column away from
		// the graph, so it is opened deliberately — and then it has to stick.
		// The refs panel is part of the graph: shown unless the user hides it.
		expect(defaultLayout().dockRefsHidden).toBe(false);
		const hidden = toggleDockRefs(defaultLayout());
		expect(hidden.dockRefsHidden).toBe(true);
		expect(normalizeLayout(JSON.parse(JSON.stringify(hidden)), []).dockRefsHidden).toBe(true);
		expect(toggleDockRefs(hidden).dockRefsHidden).toBe(false);
		expect(normalizeLayout({ dockRefsHidden: 'open' }, []).dockRefsHidden).toBe(false);
		// REGRESSION: a layout saved before this flag existed carries `dockRefs: false`,
		// which is what kept the panel invisible for the person who asked for it. The
		// legacy key must be ignored, not honoured.
		expect(normalizeLayout({ dockRefs: false }, []).dockRefsHidden).toBe(false);
	});
});

describe('[TC-PDCORE-099] the dock column is shared by the graph and the file explorer', () => {
	it('opens each half independently', () => {
		// ⚠ TWO FLAGS, NOT A MODE. One enum would mean opening the files half throws
		// away the graph, and the pair answers two questions an operator asks at the
		// same time — what changed, and what is on the machine.
		const base = normalizeLayout(null, []);
		expect([base.dockOpen, base.filesOpen]).toEqual([false, false]);
		const files = toggleFiles(base);
		expect([files.dockOpen, files.filesOpen]).toEqual([false, true]);
		const both = toggleDock(files);
		expect([both.dockOpen, both.filesOpen]).toEqual([true, true]);
		// Closing one leaves the other exactly as it was.
		expect(toggleFiles(both).dockOpen).toBe(true);
		expect(toggleDock(both).filesOpen).toBe(true);
	});

	it('stores the split as a clamped share and repairs junk', () => {
		const base = normalizeLayout(null, []);
		expect(base.filesShare).toBe(50);
		// A share, not pixels: the column itself is resizable, so a stored height
		// would overflow it or leave a gap the moment the column moved.
		expect(setFilesShare(base, 70).filesShare).toBe(70);
		expect(setFilesShare(base, 1).filesShare).toBe(FILES_SHARE_MIN);
		expect(setFilesShare(base, 200).filesShare).toBe(FILES_SHARE_MAX);
		expect(setFilesShare(base, 33.6).filesShare).toBe(34);
		expect(setFilesShare(base, Number.NaN).filesShare).toBe(base.filesShare);
		const saved = setFilesShare(toggleFiles(base), 65);
		const restored = normalizeLayout(JSON.parse(JSON.stringify(saved)), []);
		expect([restored.filesOpen, restored.filesShare]).toEqual([true, 65]);
		expect(normalizeLayout({ filesShare: 'half' }, []).filesShare).toBe(50);
	});

	it('remembers where the explorer was looking, and nothing more', () => {
		// Without this the dock reopens empty on every reload, which is a dock nobody
		// opens twice. The commit dock stores its target for the same reason.
		const base = normalizeLayout(null, []);
		expect(base.filesTarget).toBeNull();
		const at = setFilesTarget(base, 'h1', 'Project/pdmux');
		expect(at.filesTarget).toEqual({ hostId: 'h1', path: 'Project/pdmux' });
		expect(normalizeLayout(JSON.parse(JSON.stringify(at)), []).filesTarget).toEqual({
			hostId: 'h1',
			path: 'Project/pdmux',
		});
		// A target without a host is not a target.
		expect(setFilesTarget(at, null, 'anything').filesTarget).toBeNull();
		expect(normalizeLayout({ filesTarget: { path: 'x' } }, []).filesTarget).toBeNull();
		// A stored path that is not a string falls back to the home, never to junk.
		expect(normalizeLayout({ filesTarget: { hostId: 'h1', path: 7 } }, []).filesTarget).toEqual({
			hostId: 'h1',
			path: '',
		});
	});
});

describe('[TC-PDCORE-021] hidden panes are released so their session client detaches', () => {
	it('applies the TTL and the count cap, and never releases a visible pane', () => {
		// A mounted terminal holds a live session client, and an idle-stop policy
		// counts any attached client as activity — a forgotten tab would keep a host
		// awake forever.
		const now = 10 * 60_000;
		const panes = [
			{ id: 'visible', hiddenSince: null },
			{ id: 'justHidden', hiddenSince: now - 30_000 },
			{ id: 'longHidden', hiddenSince: now - 9 * 60_000 },
		];
		const opts = { ttlMs: 5 * 60_000, max: 12 };
		expect(stalePaneIds(panes, now, opts)).toEqual(['longHidden']);
		expect(stalePaneIds([{ id: 'v', hiddenSince: null }], now, opts)).toEqual([]);
		const many = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, hiddenSince: now - i * 1000 }));
		expect(stalePaneIds(many, now, { ttlMs: 60_000, max: 3 })).toEqual(['p4', 'p3']);
	});
});

describe('[TC-PDCORE-022] a pane whose cell is gone is released at once', () => {
	it('does not wait for the idle TTL', () => {
		const base = layout();
		const mounted = base.slots.map((s) => s!.id);
		expect(orphanPaneIds(mounted, base.slots)).toEqual([]);
		const cleared = clearSlot(base, 1);
		expect(orphanPaneIds(mounted, cleared.slots)).toEqual([base.slots[1]!.id]);
		expect(orphanPaneIds(mounted, removeSlot(cleared, 1).slots)).toEqual([base.slots[1]!.id]);
		expect(orphanPaneIds([base.slots[0]!.id], cleared.slots)).toEqual([]);
	});
});

describe('[TC-PDCORE-023] a backgrounded tab releases every terminal after the TTL', () => {
	it('compares against the moment the tab was hidden', () => {
		const ttlMs = 10 * 60_000;
		expect(shouldDetachAll(null, 5_000, ttlMs)).toBe(false);
		expect(shouldDetachAll(1_000, 1_000 + ttlMs - 1, ttlMs)).toBe(false);
		expect(shouldDetachAll(1_000, 1_000 + ttlMs, ttlMs)).toBe(true);
	});
});

describe('[TC-PDCORE-024] a slot knows its label and whether it can be reached', () => {
	it('marks a non-persistent shell and an offline host', () => {
		const attach = { id: 's1', hostId: 'h1', kind: 'attach' as const, session: 'main' };
		const shell = { id: 's2', hostId: 'h3', kind: 'shell' as const, session: null };
		expect(slotLabel(attach, 'alpha')).toBe('alpha·main');
		expect(slotLabel(shell, 'gamma')).toBe('gamma·shell');
		expect(isSlotReachable(attach, HOSTS)).toBe(true);
		expect(isSlotReachable(shell, HOSTS)).toBe(false); // host offline
		expect(isSlotReachable({ ...attach, hostId: 'nope' }, HOSTS)).toBe(false);
	});
});

describe('[TC-PDCORE-025] attach and new collapse into one wire target', () => {
	it('maps the UI intent onto the protocol kinds', () => {
		// Creating and joining are the same request; only the picker's wording differs.
		expect(toProtocolTarget({ id: 's1', hostId: 'h1', kind: 'attach', session: 'main' })).toEqual({
			kind: 'session',
			session: 'main',
		});
		expect(toProtocolTarget({ id: 's2', hostId: 'h1', kind: 'new', session: 'w1' })).toEqual({
			kind: 'session',
			session: 'w1',
		});
		expect(toProtocolTarget({ id: 's3', hostId: 'h1', kind: 'shell', session: null })).toEqual({ kind: 'shell' });
		expect(toProtocolTarget({ id: 's4', hostId: 'h1', kind: 'attach', session: null })).toEqual({
			kind: 'session',
			session: 'main',
		});
	});
});
