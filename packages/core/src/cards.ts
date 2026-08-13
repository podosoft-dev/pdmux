/**
 * Per-card widget visibility, and whether the card is collapsed at all.
 *
 * WHY PER CARD AND NOT GLOBAL: the operator asked for it explicitly — a host they
 * keep collapsed must stay collapsed while a host that appears later starts fully
 * expanded. A single global toggle would reset every card the moment one changed.
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
 * ⚠ `collapsed` IS NOT A WIDGET, and deliberately not in `CARD_WIDGETS`. That array
 * is three things at once — the render order, the ⚙ popover's switch list, and the
 * key set of `CardPrefs` — so a fourth entry would put a bogus "Collapsed" switch in
 * the settings popover and widen a type every consumer destructures. Collapsing is a
 * state of the CARD; the widgets are what the card shows when it is open, and they
 * have to survive being hidden and shown again.
 */
export interface CardRecord extends Partial<CardPrefs> {
	collapsed?: boolean;
}

export type CardPrefsMap = Record<string, CardRecord>;

const ALL_ON = (): CardPrefs => ({ agents: true, resources: true, links: true });

/** Resolve one card's widgets. An unknown host or junk resolves to everything on. */
export function cardPrefs(map: CardPrefsMap | undefined, hostId: string): CardPrefs {
	const saved = map && typeof map === 'object' ? map[hostId] : undefined;
	const out = ALL_ON();
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
	// ⚠ `cardPrefs` answers about WIDGETS ONLY, so spreading it would drop `collapsed`
	// — flipping one switch in the ⚙ popover would silently expand the card.
	return { ...map, [hostId]: { ...stored(map, hostId), ...current, [widget]: !current[widget] } };
}

export function isCardWidget(value: unknown): value is CardWidget {
	return typeof value === 'string' && (CARD_WIDGETS as readonly string[]).includes(value);
}

/** Is this card collapsed to its header? Unknown host or junk = open. */
export function cardCollapsed(map: CardPrefsMap | undefined, hostId: string): boolean {
	return stored(map, hostId).collapsed === true;
}

/** Fold or unfold ONE card. An empty host id is a no-op, never a throw. */
export function toggleCardCollapsed(map: CardPrefsMap, hostId: string): CardPrefsMap {
	if (!hostId) return map;
	return { ...map, [hostId]: { ...stored(map, hostId), collapsed: !cardCollapsed(map, hostId) } };
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
		// ⚠ THIS LINE IS WHY A COLLAPSED CARD SURVIVES A RELOAD. Everything persisted
		// passes through here (`normalizeLayout`, `mergeHostPrefs`, the localStorage
		// cache), and an unlisted key is DROPPED — so without it a card folds, the row
		// is written, and the next paint quietly shows it open again.
		const collapsed = (prefs as Record<string, unknown>).collapsed;
		if (typeof collapsed === 'boolean') clean.collapsed = collapsed;
		if (Object.keys(clean).length) out[hostId] = clean;
	}
	return out;
}
