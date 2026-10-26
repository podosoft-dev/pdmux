/**
 * Per-card widget visibility, whether the card is open at all, and its place in the column.
 *
 * WHY PER CARD AND NOT GLOBAL: the operator asked for it explicitly — a host they
 * opened must stay open while a host that appears later starts folded (0.17.21: every
 * card starts folded, the user opens what they need). A single global toggle would reset
 * every card the moment one changed.
 */

/** Widgets a card can hide, in render order. */
export const CARD_WIDGETS = ['agents', 'resources', 'links'] as const;
export type CardWidget = (typeof CARD_WIDGETS)[number];

/** Fully resolved visibility for one card. */
export type CardPrefs = Record<CardWidget, boolean>;

/**
 * Stored form for one card: sparse, so a widget nobody touched keeps following the
 * default.
 *
 * ⚠ FOLDING (`open`) IS NOT A WIDGET, and deliberately not in `CARD_WIDGETS`. That array
 * is three things at once — the render order, the ⚙ popover's switch list, and the
 * key set of `CardPrefs` — so a fourth entry would put a bogus "Collapsed" switch in
 * the settings popover and widen a type every consumer destructures. Collapsing is a
 * state of the CARD; the widgets are what the card shows when it is open, and they
 * have to survive being hidden and shown again.
 */
export interface CardRecord extends Partial<CardPrefs> {
	/**
	 * Unfolded by this user. A card is FOLDED unless this is `true`.
	 *
	 * ⚠ IT WAS `collapsed` UNTIL 0.17.21, with "open" as the default. The operator asked
	 * for every card to start folded and to open only what they need — including the
	 * cards they had already opened. Renaming the key is what does that: an old
	 * `collapsed: false` is simply not read any more, so every card folds once and then
	 * remembers what is opened from here on.
	 */
	open?: boolean;
	/**
	 * This user's position for the card in the column (0 = top). Per user, like the
	 * rest of this record: the organisation's own order (`hosts.sortOrder`) is shared by
	 * everyone and stays what settings › hosts edits.
	 */
	order?: number;
}

export type CardPrefsMap = Record<string, CardRecord>;

const DEFAULT_CARDS = (): CardPrefs => ({ agents: true, resources: true, links: false });

/** Resolve one card's widgets. Unknown state keeps core widgets on and service links off. */
export function cardPrefs(map: CardPrefsMap | undefined, hostId: string): CardPrefs {
	const saved = map && typeof map === 'object' ? map[hostId] : undefined;
	const out = DEFAULT_CARDS();
	if (!saved || typeof saved !== 'object') return out;
	for (const key of CARD_WIDGETS) {
		const value = (saved as Record<string, unknown>)[key];
		if (typeof value === 'boolean') out[key] = value;
	}
	return out;
}

/** Flip one widget on ONE card. An unknown widget is a no-op, never a throw. */
export function toggleCardWidget(map: CardPrefsMap, hostId: string, widget: string): CardPrefsMap {
	if (!isCardWidget(widget) || !hostId) return map;
	const current = cardPrefs(map, hostId);
	// ⚠ `cardPrefs` answers about WIDGETS ONLY, so spreading it would drop `open` and `order`
	// — flipping one switch in the ⚙ popover would silently fold or move the card.
	return { ...map, [hostId]: { ...stored(map, hostId), ...current, [widget]: !current[widget] } };
}

export function isCardWidget(value: unknown): value is CardWidget {
	return typeof value === 'string' && (CARD_WIDGETS as readonly string[]).includes(value);
}

/** Is this card folded to its header? Unknown host, junk or never opened = folded. */
export function cardCollapsed(map: CardPrefsMap | undefined, hostId: string): boolean {
	return stored(map, hostId).open !== true;
}

/** Fold or unfold ONE card. An empty host id is a no-op, never a throw. */
export function toggleCardCollapsed(map: CardPrefsMap, hostId: string): CardPrefsMap {
	if (!hostId) return map;
	const { collapsed: _legacy, ...rest } = stored(map, hostId) as CardRecord & { collapsed?: unknown };
	return { ...map, [hostId]: { ...rest, open: cardCollapsed(map, hostId) } };
}

/** This user's position for one card, or null when they never moved it. */
export function cardOrder(map: CardPrefsMap | undefined, hostId: string): number | null {
	const order = stored(map, hostId).order;
	return typeof order === 'number' && Number.isInteger(order) && order >= 0 ? order : null;
}

/**
 * The column in this user's order.
 *
 * Cards the user placed come first, by their position; the rest follow in the order they
 * arrived in (the organisation's order), so a host added later lands at the bottom rather
 * than jumping into the middle of an arrangement somebody made.
 */
export function orderHosts<T extends { id: string }>(hosts: readonly T[], map: CardPrefsMap | undefined): T[] {
	return hosts
		.map((host, index) => ({ host, index, order: cardOrder(map, host.id) }))
		.sort((a, b) => {
			if (a.order !== null && b.order !== null) return a.order - b.order || a.index - b.index;
			if (a.order !== null) return -1;
			if (b.order !== null) return 1;
			return a.index - b.index;
		})
		.map((row) => row.host);
}

/**
 * Move the card at `from` to `to` in the column as it is drawn (`orderedIds`), and give
 * EVERY card in it a position.
 *
 * Every card, not just the two that changed places: positions are only comparable when
 * they come from one numbering, and a card left without one would sort after all of them.
 * Returns the ids whose position actually changed so the caller saves only those.
 */
export function moveCard(
	map: CardPrefsMap,
	orderedIds: readonly string[],
	from: number,
	to: number,
): { map: CardPrefsMap; changed: string[] } {
	const ids = [...orderedIds];
	if (from === to || from < 0 || to < 0 || from >= ids.length || to >= ids.length) return { map, changed: [] };
	const [moved] = ids.splice(from, 1);
	if (moved === undefined) return { map, changed: [] };
	ids.splice(to, 0, moved);
	const next: CardPrefsMap = { ...map };
	const changed: string[] = [];
	ids.forEach((id, order) => {
		if (cardOrder(map, id) === order) return;
		next[id] = { ...stored(map, id), order };
		changed.push(id);
	});
	return { map: next, changed };
}

/** The persisted record for one host, or an empty one. Never null, never junk. */
function stored(map: CardPrefsMap | undefined, hostId: string): CardRecord {
	const saved = map && typeof map === 'object' ? map[hostId] : undefined;
	return saved && typeof saved === 'object' ? saved : {};
}

/**
 * Clean a persisted map: known keys with boolean values only.
 *
 * Entries for hosts that are not in the current fleet snapshot are KEPT on purpose —
 * a stopped host still has a card, and one that comes back should find its own
 * setting rather than a reset one.
 */
export function sanitizeCardPrefs(raw: unknown): CardPrefsMap {
	const out: CardPrefsMap = {};
	if (!raw || typeof raw !== 'object') return out;
	for (const [hostId, prefs] of Object.entries(raw as Record<string, unknown>)) {
		if (!hostId || !prefs || typeof prefs !== 'object') continue;
		const clean: CardRecord = {};
		for (const key of CARD_WIDGETS) {
			const value = (prefs as Record<string, unknown>)[key];
			if (typeof value === 'boolean') clean[key] = value;
		}
		// ⚠ THESE LINES ARE WHY AN OPENED CARD AND A MOVED CARD SURVIVE A RELOAD. Everything
		// persisted passes through here (`normalizeLayout`, `mergeHostPrefs`, the
		// localStorage cache), and an unlisted key is DROPPED — so without them the row is
		// written and the next paint quietly shows the card folded, or back in its old place.
		// The legacy `collapsed` key is dropped on purpose (see `CardRecord.open`).
		const open = (prefs as Record<string, unknown>).open;
		if (typeof open === 'boolean') clean.open = open;
		const order = (prefs as Record<string, unknown>).order;
		if (typeof order === 'number' && Number.isInteger(order) && order >= 0) clean.order = order;
		if (Object.keys(clean).length) out[hostId] = clean;
	}
	return out;
}
