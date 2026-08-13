/**
 * Terminal grid state machine.
 *
 * THE MODEL: a split is a grid of POSITIONAL CELLS. `slots` is an array where each
 * index is one cell and `null` means "empty". Closing a pane empties its cell
 * instead of pulling the next terminal into it — with a plain list, closing looked
 * like it OPENED a window, because the following terminal slid into the freed cell.
 *
 * Every reducer here is PURE and TOTAL: it returns a new layout, never touches the
 * DOM, and junk input yields a sane layout rather than a throw. That is what lets
 * the same layout be persisted server-side (per-user personalisation) and hydrated
 * on another device with identical results.
 */
import { type CardPrefsMap, sanitizeCardPrefs } from './cards.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Panes shown per mode — also the paging window size. */
export const GRID_SIZE = { tab: 1, split2: 2, split4: 4, split9: 9 } as const;
export type GridMode = keyof typeof GRID_SIZE;

/** Columns per mode. 4-up is 2x2 and 9-up is 3x3, so this is not `GRID_SIZE`. */
export const GRID_COLUMNS: Record<GridMode, number> = { tab: 1, split2: 2, split4: 2, split9: 3 };

/**
 * What a cell points at.
 *  - `attach`: join a multiplexer session that already exists
 *  - `new`: create one (same wire target as `attach`; the difference is UI intent)
 *  - `shell`: a bare login shell — dies with the connection, so the UI warns
 */
export type SlotKind = 'attach' | 'new' | 'shell';

export interface TerminalSlot {
	/** Unique within a layout, and stable across reloads (see `nextSlotId`). */
	id: string;
	hostId: string;
	kind: SlotKind;
	/** Session name for `attach`/`new`; null for `shell`. */
	session: string | null;
}

export type GridCell = TerminalSlot | null;

/** What a click on an unfocused pane does. */
export type ClickAction = 'zoom' | 'focus';

/** Which repository the read-only commit dock shows. */
/** Where the file explorer was last looking, so reopening it lands there. */
export interface FilesTarget {
	hostId: string;
	/** Relative to that host's home directory; '' is the home itself. */
	path: string;
}

export interface DockTarget {
	hostId: string;
	repo: string | null;
}

/**
 * The whole personalisable surface, serialisable as-is.
 *
 * Zoom is a separate field rather than a mode, so leaving zoom restores the exact
 * previous mode+page instead of guessing one.
 */
export interface TerminalLayout {
	mode: GridMode;
	page: number;
	slots: GridCell[];
	zoomId: string | null;
	focusId: string | null;
	clickAction: ClickAction;
	sidebarOpen: boolean;
	sidebarWidth: number;
	dockOpen: boolean;
	dockWidth: number;
	/**
	 * The file explorer, which shares the dock COLUMN with the commit dock rather
	 * than taking a track of its own.
	 *
	 * ⚠ IT IS ITS OWN FLAG, NOT A MODE OF `dockOpen`. The two answer different
	 * questions — "what changed in this repository" and "what is on this machine" —
	 * and an operator watching a build wants both at once. A single enum would have
	 * made that impossible and would have thrown away whichever panel was open
	 * every time the other was wanted.
	 */
	filesOpen: boolean;
	/**
	 * How much of the dock column the file explorer takes, as a percentage.
	 *
	 * A share rather than pixels: the column itself is resizable, and a stored
	 * height would either overflow it or leave a gap the moment the column moved.
	 */
	filesShare: number;
	/**
	 * Where the file explorer was last looking.
	 *
	 * ⚠ THE PATH TRAVELS WITH THE HOST, AND IT IS RELATIVE TO THAT HOST'S HOME. A
	 * dock that reopens on an empty panel every reload is a dock nobody uses twice;
	 * the commit dock stores its target for the same reason. What is NOT stored is a
	 * selection — a directory is true for an instant, and restoring a name that is
	 * gone would mark a row that no longer exists.
	 */
	filesTarget: FilesTarget | null;
	/** Whether the dock shows the repository's refs panel beside the graph. */
	/**
	 * The refs panel is part of the graph, so it is **shown** unless the user hides
	 * it. Stored as "hidden" on purpose: a flag stored as "shown" pins whatever it
	 * was on the day it was written, and the value written by the first render then
	 * outlives every later default — which is exactly how a panel that was asked for
	 * stayed invisible for the person who asked (measured: a saved layout carrying
	 * `dockRefs: false`).
	 */
	dockRefsHidden: boolean;
	/**
	 * How tall the commit detail is, in px, or `null` for "as tall as its content".
	 *
	 * Null by default because a fixed height would pad a one-line commit message with
	 * empty space; the moment the user drags the handle it becomes their number and
	 * survives reloads like every other view choice.
	 */
	dockDetailHeight: number | null;
	dockTarget: DockTarget | null;
	cards: CardPrefsMap;
}

/** A multiplexer session on a host, as the picker needs it. */
export interface GridSession {
	name: string;
	attached?: number;
	windows?: number;
}

/** A host, reduced to what the grid needs. Structurally a subset of the API's host. */
export interface GridHost {
	id: string;
	name: string;
	/** Reachable right now. A slot on an offline host is kept — it works again later. */
	online: boolean;
	sessions?: readonly GridSession[];
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 720;
export const DOCK_WIDTH_MIN = 260;
export const DOCK_WIDTH_MAX = 900;
/** The detail panel's bounds. The upper one is a guard, not a preference: the
 *  stylesheet also caps it at a share of the column so the graph cannot be squeezed
 *  out of the dock and the page cannot start scrolling (ARCHITECTURE §7). */
export const DETAIL_HEIGHT_MIN = 120;
export const DETAIL_HEIGHT_MAX = 900;

/** Gesture thresholds for the pane click guard (see `guardIntent`). */
export const DRAG_PX = 6;
export const DRAG_MS = 400;

const clamp = (px: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(px)));

export const defaultLayout = (): TerminalLayout => ({
	// The terminals own a full-height column, so a split is the useful default.
	mode: 'split4',
	page: 0,
	// Empty on purpose: a fresh split shows cells to fill, nothing auto-placed.
	slots: [],
	zoomId: null,
	focusId: null,
	clickAction: 'zoom',
	sidebarOpen: true,
	sidebarWidth: 300,
	dockOpen: false,
	dockWidth: 420,
	filesOpen: false,
	filesShare: 50,
	filesTarget: null,
	dockRefsHidden: false,
	dockDetailHeight: null,
	dockTarget: null,
	cards: {},
});

// ---------------------------------------------------------------------------
// Slot identity
// ---------------------------------------------------------------------------

const ID_PATTERN = /^s(\d+)$/;

/**
 * Next free slot id, derived from the layout itself.
 *
 * WHY NOT A MODULE COUNTER: the original kept a counter that restarted on every page
 * load while `slots` came back from storage, so the next assignment re-issued an
 * existing id, two cells resolved to the SAME pane element and a terminal appeared
 * in the wrong cell ("the window was added twice"). Deriving the id from the current
 * slots makes that impossible AND keeps the reducers pure.
 */
export function nextSlotId(slots: readonly GridCell[]): string {
	let max = 0;
	for (const slot of slots) {
		const found = slot ? ID_PATTERN.exec(slot.id) : null;
		if (found) max = Math.max(max, Number(found[1]));
	}
	return `s${max + 1}`;
}

/** Compose a display label. The consumer may replace it through its own i18n. */
export function slotLabel(slot: TerminalSlot, hostName: string): string {
	return `${hostName}·${slot.kind === 'shell' ? 'shell' : (slot.session ?? '')}`;
}

/** True when a slot's terminal can be reached right now. */
export function isSlotReachable(slot: TerminalSlot, hosts: readonly GridHost[]): boolean {
	return hosts.some((h) => h.id === slot.hostId && h.online);
}

/**
 * The wire target for a slot.
 *
 * `attach` and `new` collapse into one protocol kind by design: creating and
 * joining are the same request (`new -A -s`), and only the picker's wording differs.
 */
export function toProtocolTarget(slot: TerminalSlot): { kind: 'session' | 'shell'; session?: string } {
	if (slot.kind === 'shell') return { kind: 'shell' };
	return { kind: 'session', session: slot.session ?? 'main' };
}

const sessionNames = (hosts: readonly GridHost[], hostId: string): string[] =>
	(hosts.find((h) => h.id === hostId)?.sessions ?? []).map((s) => s.name);

/** Lowest free `w<N>` for a host, considering live sessions and names already taken. */
export function nextSessionName(hosts: readonly GridHost[], hostId: string, taken: readonly string[] = []): string {
	const used = new Set([...sessionNames(hosts, hostId), ...taken]);
	for (let i = 1; ; i++) if (!used.has(`w${i}`)) return `w${i}`;
}

// ---------------------------------------------------------------------------
// Default arrangement
// ---------------------------------------------------------------------------

export interface DefaultSlotOptions {
	/** Spare "new session" cells appended per host so a 9-up grid can be filled. */
	pad?: number;
	/**
	 * Sessions to keep OUT of the default arrangement (they stay fully pickable).
	 * Long-running service runners are servers, not work surfaces, and twenty of
	 * them would bury the interactive ones.
	 */
	excludePrefix?: string;
}

export interface StarterCellOptions {
	/** How many cells a first visit opens with. Default 4 — exactly one 2x2 split. */
	count?: number;
	/** The one session name a starter cell may join. Default `main`. */
	prefer?: string;
}

/**
 * The arrangement of a FIRST visit: at most one attached terminal, everything else an
 * empty cell the user fills themselves.
 *
 * WHY NOT `buildDefaultSlots`: it puts a cell on every live session of every online
 * host plus spares per host, which on a real fleet opened dozens of panes across ~33
 * pages, exhausted the agent's PTY cap and printed "terminal limit reached" into the
 * panes instead of showing a dashboard.
 *
 * WHY IT NEVER CREATES OR GUESSES A SESSION: a multiplexer session belongs to whoever
 * is working in it, and auto-attaching to whatever happened to be running has already
 * put keystrokes into a live agent's session here. `main` is the single name this tool
 * owns by convention, so it is the only thing a first paint joins — no `new` cells, and
 * no reaching past the first reachable host.
 */
export function starterCells(hosts: readonly GridHost[], opts: StarterCellOptions = {}): GridCell[] {
	const count = Number.isInteger(opts.count) && (opts.count as number) >= 0 ? (opts.count as number) : 4;
	const prefer = typeof opts.prefer === 'string' && opts.prefer ? opts.prefer : 'main';
	// Read-only lookups only: `hosts` is the array the fleet feed owns and re-renders
	// from, so an in-place sort here would reorder the sidebar as a side effect.
	const host = hosts.find((h) => h.online);
	const joinable = host ? (host.sessions ?? []).some((s) => s.name === prefer) : false;
	const first: GridCell =
		host && joinable ? { id: nextSlotId([]), hostId: host.id, kind: 'attach', session: prefer } : null;
	return Array.from({ length: count }, (_, index) => (index === 0 ? first : null));
}

/** Online hosts by name, `main` first then the other live sessions alphabetically. */
export function buildDefaultSlots(hosts: readonly GridHost[], opts: DefaultSlotOptions = {}): GridCell[] {
	const pad = Number.isInteger(opts.pad) ? (opts.pad as number) : 2;
	const skip = typeof opts.excludePrefix === 'string' ? opts.excludePrefix : '';
	const out: GridCell[] = [];
	let seq = 0;
	const mint = (): string => `s${++seq}`;
	for (const host of [...hosts].sort((a, b) => a.name.localeCompare(b.name))) {
		if (!host.online) continue;
		const live = (host.sessions ?? [])
			.map((s) => s.name)
			.filter((n) => !(skip && n.startsWith(skip)))
			.sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)));
		for (const session of live) out.push({ id: mint(), hostId: host.id, kind: 'attach', session });
		const taken: string[] = [];
		for (let i = 0; i < pad; i++) {
			const session = nextSessionName(hosts, host.id, taken);
			taken.push(session);
			out.push({ id: mint(), hostId: host.id, kind: 'new', session });
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Views (derived, never stored)
// ---------------------------------------------------------------------------

const cells = (layout: TerminalLayout): GridCell[] => (Array.isArray(layout.slots) ? layout.slots : []);

/** Drop trailing empty cells so the spare page never creeps outward. */
const trimTail = (list: GridCell[]): GridCell[] => {
	const out = [...list];
	while (out.length && !out[out.length - 1]) out.pop();
	return out;
};

/**
 * Pages over the cells, plus ONE spare page of empty cells when the last page is
 * full — so the user can always page right and compose more terminals.
 */
export function pageCount(layout: TerminalLayout): number {
	const size = GRID_SIZE[layout.mode] ?? GRID_SIZE.split4;
	const used = cells(layout).length;
	if (used === 0) return 1;
	return Math.ceil(used / size) + (used % size === 0 ? 1 : 0);
}

/** Clamped page — a stored page past the end reads as the last page. */
export function clampedPage(layout: TerminalLayout): number {
	return Math.min(Math.max(0, layout.page | 0), pageCount(layout) - 1);
}

/**
 * Cells to render: the zoomed slot alone, else the current page window.
 *
 * The window is ALWAYS `size(mode)` long — missing cells render as empty
 * placeholders, which is what keeps the layout stable when a pane is closed.
 */
export function visibleSlots(layout: TerminalLayout): GridCell[] {
	const list = cells(layout);
	if (layout.zoomId) {
		const zoomed = list.find((s) => s && s.id === layout.zoomId);
		if (zoomed) return [zoomed];
	}
	const size = GRID_SIZE[layout.mode] ?? GRID_SIZE.split4;
	const start = clampedPage(layout) * size;
	return Array.from({ length: size }, (_, i) => list[start + i] ?? null);
}

/** Cell index of each visible slot, so a UI can address the cell it renders. */
export function visibleIndexes(layout: TerminalLayout): number[] {
	const list = cells(layout);
	if (layout.zoomId) {
		const index = list.findIndex((s) => s && s.id === layout.zoomId);
		if (index >= 0) return [index];
	}
	const size = GRID_SIZE[layout.mode] ?? GRID_SIZE.split4;
	const start = clampedPage(layout) * size;
	return Array.from({ length: size }, (_, i) => start + i);
}

/** Index the user is "at" — the focused pane, else the first cell on the page. */
/**
 * The cell a single-pane screen should show: the one the user is on (focus, else zoom),
 * else the first cell of the stored page.
 *
 * Exported as `soloIndex` because a narrow screen needs the same anchor `cycleMode` uses
 * internally — the phone's cursor and the desktop's focus ring must agree about "where
 * the user is", or switching devices moves the user without telling them.
 */
function anchorIndex(layout: TerminalLayout): number {
	const list = cells(layout);
	const focused = layout.focusId ?? layout.zoomId;
	const index = focused ? list.findIndex((s) => s && s.id === focused) : -1;
	return index >= 0 ? index : clampedPage(layout) * (GRID_SIZE[layout.mode] ?? GRID_SIZE.split4);
}

/** Lowest empty cell, else one past the end (where a new terminal should land). */
export function firstEmptyIndex(layout: TerminalLayout): number {
	const list = cells(layout);
	const hole = list.findIndex((s) => !s);
	return hole >= 0 ? hole : list.length;
}

/**
 * An empty cell is either a HOLE (a `null` inside `slots`, left by closing a
 * terminal) or PADDING (past the end of the array, drawn only to fill the window).
 * Only a hole has following cells to pull forward, so only a hole can be closed —
 * a UI disables the close button on padding instead of offering a dead one.
 */
export function emptyCellKind(layout: TerminalLayout, index: number): 'hole' | 'padding' | null {
	const list = cells(layout);
	if (index >= list.length) return 'padding';
	return list[index] ? null : 'hole';
}

// ---------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------

const withPage = (layout: TerminalLayout): TerminalLayout => ({
	...layout,
	page: Math.min(Math.max(0, layout.page | 0), pageCount(layout) - 1),
});

/**
 * Mode button. Pressing the ACTIVE mode again advances to the next page (so the same
 * button walks the fleet: 1-4 -> 5-8 -> …); a different mode keeps the anchor
 * terminal on screen. Both always leave zoom.
 */
export function cycleMode(layout: TerminalLayout, mode: GridMode): TerminalLayout {
	if (!(mode in GRID_SIZE)) return layout;
	if (layout.mode === mode) {
		const next = { ...layout, zoomId: null };
		return { ...next, page: (clampedPage(next) + 1) % pageCount(next) };
	}
	const anchor = anchorIndex(layout);
	const next = { ...layout, mode, zoomId: null };
	return { ...next, page: Math.min(Math.floor(anchor / GRID_SIZE[mode]), pageCount(next) - 1) };
}

/** Explicit pager — wraps in both directions. */
export function movePage(layout: TerminalLayout, delta: number): TerminalLayout {
	const count = pageCount(layout);
	const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
	return { ...layout, page: (((clampedPage(layout) + step) % count) + count) % count };
}

/**
 * The width at which the shell stops putting its regions side by side, in px.
 *
 * ⚠ The same number lives in `@pdmux/ui`'s stylesheet, which cannot read TypeScript. A
 * package contract test compares the two, because the app reads THIS one to decide
 * single-pane rendering: one pixel of drift and the CSS shows a 3x3 grid while the code
 * believes one cell is on screen.
 */
export const SHELL_STACK_MAX_WIDTH = 900;

/** Which cell a single-pane screen shows. See `anchorIndex`. */
export const soloIndex = anchorIndex;

/**
 * The layout a single-pane screen renders: one cell, and it is `index`.
 *
 * A VIEW, NEVER A STORED VALUE. `mode` is the user's desktop split — persisted per user
 * and shared across devices — so a phone that wrote `tab` into it would silently reduce
 * everyone's desktop to one terminal. The coercion therefore happens on the way INTO the
 * grid and the stored document is left alone.
 *
 * `mode: 'tab'` is what keeps the indexes honest: with a window of one, page N *is* cell
 * N, so `visibleIndexes()` returns the real cell index and every callback (`onClose`,
 * `onAssign`, `onSwap`) addresses the stored layout correctly with no translation layer
 * to get wrong.
 */
export function soloLayout(layout: TerminalLayout, index: number = anchorIndex(layout)): TerminalLayout {
	const list = cells(layout);
	const at = Math.min(Math.max(0, Number.isFinite(index) ? Math.trunc(index) : 0), list.length);
	return { ...layout, mode: 'tab', page: at, zoomId: null };
}

/**
 * Step the single-pane cursor, wrapping.
 *
 * Reuses `movePage`, so paging a phone and paging a desktop are the same rule with a
 * window of one — including the one spare empty cell at the end, which is how a phone
 * reaches "add a terminal".
 */
export function soloStep(layout: TerminalLayout, index: number, delta: number): number {
	return movePage(soloLayout(layout, index), delta).page;
}

/** Zoom toggle: the same id clears the zoom, a different id moves it. */
export function toggleZoom(layout: TerminalLayout, slotId: string | null): TerminalLayout {
	if (!slotId) return layout; // empty cell — nothing to zoom
	return { ...layout, zoomId: layout.zoomId === slotId ? null : slotId, focusId: slotId };
}

/** Focus without zooming — how a drag-intent press lands (see `guardIntent`). */
export function focusSlot(layout: TerminalLayout, slotId: string | null): TerminalLayout {
	return { ...layout, focusId: slotId };
}

/** Put a target into cell `index`, growing the grid with empty cells if needed. */
export function assignSlot(
	layout: TerminalLayout,
	index: number,
	target: { hostId: string; kind: SlotKind; session?: string | null },
): TerminalLayout {
	if (!Number.isInteger(index) || index < 0 || !target || typeof target.hostId !== 'string') return layout;
	const list = [...cells(layout)];
	while (list.length < index) list.push(null);
	list[index] = {
		id: nextSlotId(list),
		hostId: target.hostId,
		kind: target.kind === 'shell' || target.kind === 'new' ? target.kind : 'attach',
		session: target.kind === 'shell' ? null : String(target.session ?? 'main'),
	};
	return { ...layout, slots: list };
}

/**
 * Close a pane: empty its cell IN PLACE. Never splice — with a plain list the
 * following terminal slid into the freed cell, so closing looked like opening.
 */
export function clearSlot(layout: TerminalLayout, index: number): TerminalLayout {
	const list = [...cells(layout)];
	const gone = list[index];
	if (!gone) return layout;
	list[index] = null;
	return withPage({
		...layout,
		slots: trimTail(list),
		zoomId: layout.zoomId === gone.id ? null : layout.zoomId,
		focusId: layout.focusId === gone.id ? null : layout.focusId,
	});
}

/**
 * Close an EMPTY cell: splice it out so the following panes move forward. Filled
 * cells are untouched (that is `clearSlot`, which keeps the position on purpose),
 * and padding has nothing to pull.
 */
export function removeSlot(layout: TerminalLayout, index: number): TerminalLayout {
	if (emptyCellKind(layout, index) !== 'hole') return layout;
	const list = cells(layout);
	return withPage({ ...layout, slots: trimTail([...list.slice(0, index), ...list.slice(index + 1)]) });
}

/**
 * Exchange two cells — how a header drag lands. Dropping onto an empty cell is
 * therefore a move (the source becomes empty). `zoomId`/`focusId` reference slot
 * ids, so the zoom follows the terminal rather than the position.
 */
export function swapSlots(layout: TerminalLayout, i: number, j: number): TerminalLayout {
	if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i === j) return layout;
	const list = [...cells(layout)];
	while (list.length <= Math.max(i, j)) list.push(null);
	const a = list[i] ?? null;
	const b = list[j] ?? null;
	list[i] = b;
	list[j] = a;
	return { ...layout, slots: trimTail(list) };
}

/**
 * Picker "apply": write into the cell it was opened from, or into the first empty
 * cell when it was opened from the "add" affordance (index = null). Pure so the
 * choice is unit-tested — a UI-layer slip here once turned every retarget into an
 * append.
 */
export function pickerApply(
	layout: TerminalLayout,
	index: number | null,
	target: { hostId: string; kind: SlotKind; session?: string | null },
): TerminalLayout {
	return assignSlot(layout, Number.isInteger(index) ? (index as number) : firstEmptyIndex(layout), target);
}

export function toggleSidebar(layout: TerminalLayout): TerminalLayout {
	return { ...layout, sidebarOpen: !layout.sidebarOpen };
}

/** Sidebar width from a splitter drag, clamped to a usable range. */
export function setSidebarWidth(layout: TerminalLayout, px: number): TerminalLayout {
	return Number.isFinite(px)
		? { ...layout, sidebarWidth: clamp(px, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX) }
		: layout;
}

export function setClickAction(layout: TerminalLayout, action: string): TerminalLayout {
	return action === 'zoom' || action === 'focus' ? { ...layout, clickAction: action } : layout;
}

/** Show/hide the commit dock. Only the column collapses — the view stays mounted. */
export function toggleFiles(layout: TerminalLayout): TerminalLayout {
	return { ...layout, filesOpen: !layout.filesOpen };
}

/** Clamped so neither panel can be dragged away to nothing. */
export const FILES_SHARE_MIN = 20;
export const FILES_SHARE_MAX = 80;

export function setFilesShare(layout: TerminalLayout, share: number): TerminalLayout {
	return Number.isFinite(share)
		? { ...layout, filesShare: clamp(Math.round(share), FILES_SHARE_MIN, FILES_SHARE_MAX) }
		: layout;
}

export function setFilesTarget(layout: TerminalLayout, hostId: string | null, path: string): TerminalLayout {
	return { ...layout, filesTarget: hostId ? { hostId, path } : null };
}

export function toggleDock(layout: TerminalLayout): TerminalLayout {
	return { ...layout, dockOpen: !layout.dockOpen };
}

export function setDockWidth(layout: TerminalLayout, px: number): TerminalLayout {
	return Number.isFinite(px) ? { ...layout, dockWidth: clamp(px, DOCK_WIDTH_MIN, DOCK_WIDTH_MAX) } : layout;
}

/**
 * Resize the commit detail. A non-finite value (a drag that never moved, a corrupt
 * stored number) leaves the layout untouched rather than writing NaN into it.
 */
export function setDockDetailHeight(layout: TerminalLayout, px: number): TerminalLayout {
	if (!Number.isFinite(px)) return layout;
	return { ...layout, dockDetailHeight: clamp(px, DETAIL_HEIGHT_MIN, DETAIL_HEIGHT_MAX) };
}

/** Back to content height — the state a layout starts in. */
export function clearDockDetailHeight(layout: TerminalLayout): TerminalLayout {
	return { ...layout, dockDetailHeight: null };
}

/** Show or hide the dock's refs panel. Persisted like every other view choice. */
export function toggleDockRefs(layout: TerminalLayout): TerminalLayout {
	return { ...layout, dockRefsHidden: !layout.dockRefsHidden };
}

/**
 * Which host/repo the dock shows. Kept in the layout (not only in the view) so a
 * reload restores the same target and a detached window can be opened with it.
 */
export function setDockTarget(layout: TerminalLayout, target: { hostId?: unknown; repo?: unknown } | null): TerminalLayout {
	const hostId = typeof target?.hostId === 'string' ? target.hostId : null;
	const repo = typeof target?.repo === 'string' ? target.repo : null;
	return { ...layout, dockTarget: hostId ? { hostId, repo } : null };
}

// ---------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------

export interface PointerSample {
	x: number;
	y: number;
	t: number;
}

/**
 * Classify a gesture on a pane's click guard.
 *
 * ⚠ THE COMMENT HERE USED TO SAY the guard was "the only way to offer click-to-zoom,
 * because a terminal surface never reports its own clicks to the page around it". That
 * was wrong, and believing it cost the product its text selection: a terminal reports
 * every press as a POINTER event to any ancestor listening, and xterm registers no
 * pointer listeners at all. The overlay it justified won the hit test and swallowed
 * every drag, so nothing could be selected or copied.
 *
 * The classifier itself was never the problem and is unchanged — it is now fed by
 * pointer events on the pane body. A quick, still press is a click; anything longer or
 * wider is a drag, which the terminal underneath gets to keep.
 */
export function guardIntent(down: PointerSample, up: PointerSample): 'click' | 'drag' {
	const moved = Math.hypot(up.x - down.x, up.y - down.y);
	return moved <= DRAG_PX && up.t - down.t <= DRAG_MS ? 'click' : 'drag';
}

export interface CellRect {
	index: number;
	rect: { left: number; top: number; right: number; bottom: number };
}

/**
 * Which visible cell a pointer is over.
 *
 * HTML5 drag & drop is unusable here — an embedded terminal swallows `dragover` —
 * so the header captures the pointer and the drop target is resolved from the
 * cells' rects instead. Boundaries belong to exactly one cell (no double match).
 */
export function dropTargetIndex(rects: readonly CellRect[], point: { x: number; y: number }): number | null {
	for (const { index, rect } of rects) {
		if (point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom) return index;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Mounted-pane lifecycle
// ---------------------------------------------------------------------------

export interface MountedPane {
	id: string;
	/** Epoch ms since the pane stopped being visible; null while it is on screen. */
	hiddenSince: number | null;
}

/**
 * Which mounted panes to release.
 *
 * This is not about memory: a mounted terminal holds a live session client, and an
 * idle-stop policy counts any attached client as activity — a forgotten dashboard
 * tab would keep a host awake forever. Hidden panes are released after `ttlMs`, and
 * the count cap still evicts the oldest hidden ones. Visible panes are never
 * released.
 */
export function stalePaneIds(
	panes: readonly MountedPane[],
	now: number,
	opts: { ttlMs?: number; max?: number } = {},
): string[] {
	const ttlMs = opts.ttlMs ?? 10 * 60_000;
	const max = opts.max ?? 12;
	const hidden = panes
		.filter((p): p is MountedPane & { hiddenSince: number } => typeof p.hiddenSince === 'number')
		.sort((a, b) => a.hiddenSince - b.hiddenSince);
	const stale = hidden.filter((p) => now - p.hiddenSince >= ttlMs).map((p) => p.id);
	const over = Math.max(0, panes.length - max);
	const capped = hidden
		.filter((p) => !stale.includes(p.id))
		.slice(0, over)
		.map((p) => p.id);
	return [...stale, ...capped];
}

/**
 * Mounted panes whose cell no longer exists at all. Unlike a pane that merely
 * scrolled off screen, these can never come back, so they are released at once
 * instead of waiting for the TTL — a closed terminal must not keep its session
 * client attached for minutes.
 */
export function orphanPaneIds(mountedIds: readonly string[], slots: readonly GridCell[]): string[] {
	const live = new Set((slots ?? []).filter((s): s is TerminalSlot => Boolean(s)).map((s) => s.id));
	return mountedIds.filter((id) => !live.has(id));
}

/** True once the browser tab has been in the background longer than the TTL. */
export function shouldDetachAll(tabHiddenSince: number | null, now: number, ttlMs = 10 * 60_000): boolean {
	return tabHiddenSince != null && now - tabHiddenSince >= ttlMs;
}

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

const isSlotKind = (value: unknown): value is SlotKind => value === 'attach' || value === 'new' || value === 'shell';

/**
 * How much the caller actually knows about the fleet.
 *
 * `fleetKnown: false` means "the host list could not be read", which is NOT the same
 * statement as "there are no hosts" — see `normalizeLayout`.
 */
export interface NormalizeLayoutOptions {
	fleetKnown?: boolean;
}

/**
 * Hydrate a persisted layout against the current fleet.
 *
 * Rules that matter:
 *  - anything unusable becomes an EMPTY cell rather than shifting the user's layout;
 *  - a slot on a host that no longer exists is dropped, but a slot on an OFFLINE
 *    host is kept — it works again when the host comes back;
 *  - a duplicate id (a crashed write, two tabs) is re-issued, because two cells
 *    resolving to one pane makes a terminal appear in the wrong cell.
 *
 * ⚠ AN EMPTY `hosts` ARRAY IS AMBIGUOUS, AND GETTING IT WRONG DESTROYS DATA. The
 * shell's loader falls back to `[]` when `GET /api/hosts` fails, so "the API was
 * restarting" arrives here looking exactly like "the operator deleted every host".
 * Read the second way, every slot is dropped, the trailing-empty trim collapses the
 * array, and the next thing the user touches persists `slots: []` — a screenful of
 * terminals gone, with no undo and nothing in any log. It happened twice on
 * 2026-07-27 before the cause was found.
 *
 * So the fleet must be KNOWN before absence is treated as deletion. `fleetKnown`
 * defaults to `true` because the ordinary caller has a fleet in hand; the callers
 * that may not (a failed load, a feed that has never polled) pass `false` and every
 * slot is kept as stored. Keeping a slot for a host that really is gone costs one
 * empty-looking cell until the next successful load; the other way costs the layout.
 */
export function normalizeLayout(
	raw: unknown,
	hosts: readonly GridHost[] = [],
	options: NormalizeLayoutOptions = {},
): TerminalLayout {
	const base = defaultLayout();
	const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const fleetKnown = options.fleetKnown !== false;
	const known = new Set(hosts.map((h) => h.id));
	const hostExists = (id: string): boolean => (fleetKnown ? known.has(id) : true);
	const stored = Array.isArray(input.slots) ? (input.slots as unknown[]) : [];
	const claimed = new Set<string>();
	const slots: GridCell[] = stored.map((entry) => {
		const slot = (entry && typeof entry === 'object' ? entry : null) as Record<string, unknown> | null;
		if (!slot || typeof slot.hostId !== 'string' || !hostExists(slot.hostId)) return null;
		const kind = isSlotKind(slot.kind) ? slot.kind : 'attach';
		// A duplicate id (a crashed write, two tabs) keeps the FIRST cell and blanks
		// the later one, which the second pass re-issues.
		const id = typeof slot.id === 'string' && slot.id && !claimed.has(slot.id) ? slot.id : '';
		if (id) claimed.add(id);
		return {
			id,
			hostId: slot.hostId,
			kind,
			session: kind === 'shell' ? null : String(slot.session ?? 'main'),
		};
	});
	// Re-issue only after every stored id is known, so a replacement cannot collide
	// with an id that appears LATER in storage.
	for (const slot of slots) {
		if (slot && !slot.id) slot.id = nextSlotId(slots);
	}
	while (slots.length && !slots[slots.length - 1]) slots.pop();

	const layout: TerminalLayout = {
		...base,
		mode: typeof input.mode === 'string' && input.mode in GRID_SIZE ? (input.mode as GridMode) : base.mode,
		page: Number.isInteger(input.page) && (input.page as number) >= 0 ? (input.page as number) : 0,
		slots,
		clickAction: input.clickAction === 'focus' || input.clickAction === 'zoom' ? input.clickAction : base.clickAction,
		sidebarOpen: typeof input.sidebarOpen === 'boolean' ? input.sidebarOpen : base.sidebarOpen,
		sidebarWidth: Number.isFinite(input.sidebarWidth)
			? clamp(input.sidebarWidth as number, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX)
			: base.sidebarWidth,
		dockOpen: typeof input.dockOpen === 'boolean' ? input.dockOpen : base.dockOpen,
		filesOpen: typeof input.filesOpen === 'boolean' ? input.filesOpen : base.filesOpen,
		filesShare: Number.isFinite(input.filesShare)
			? clamp(input.filesShare as number, FILES_SHARE_MIN, FILES_SHARE_MAX)
			: base.filesShare,
		// The legacy `dockRefs` key is deliberately NOT read: it was written false by
		// default, so honouring it would keep the panel hidden for every user who
		// opened the dock before this changed.
		dockRefsHidden: typeof input.dockRefsHidden === 'boolean' ? input.dockRefsHidden : base.dockRefsHidden,
		dockDetailHeight: Number.isFinite(input.dockDetailHeight)
			? clamp(input.dockDetailHeight as number, DETAIL_HEIGHT_MIN, DETAIL_HEIGHT_MAX)
			: base.dockDetailHeight,
		dockWidth: Number.isFinite(input.dockWidth)
			? clamp(input.dockWidth as number, DOCK_WIDTH_MIN, DOCK_WIDTH_MAX)
			: base.dockWidth,
		dockTarget: null,
		filesTarget: null,
		cards: sanitizeCardPrefs(input.cards),
	};
	const target = input.dockTarget as { hostId?: unknown; repo?: unknown } | null;
	layout.dockTarget =
		target && typeof target.hostId === 'string'
			? { hostId: target.hostId, repo: typeof target.repo === 'string' ? target.repo : null }
			: null;

	const files = input.filesTarget as { hostId?: unknown; path?: unknown } | null;
	layout.filesTarget =
		files && typeof files.hostId === 'string'
			? { hostId: files.hostId, path: typeof files.path === 'string' ? files.path : '' }
			: null;

	const has = (id: unknown): boolean => typeof id === 'string' && layout.slots.some((s) => s?.id === id);
	layout.zoomId = has(input.zoomId) ? (input.zoomId as string) : null;
	layout.focusId = has(input.focusId) ? (input.focusId as string) : null;
	layout.page = Math.min(layout.page, pageCount(layout) - 1);
	return layout;
}
