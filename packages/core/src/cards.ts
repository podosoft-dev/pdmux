/**
 * Per-card widget visibility.
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

/** Stored form: sparse, so a widget nobody touched keeps following the default. */
export type CardPrefsMap = Record<string, Partial<CardPrefs>>;

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
	return { ...map, [hostId]: { ...current, [widget]: !current[widget] } };
}

export function isCardWidget(value: unknown): value is CardWidget {
	return typeof value === 'string' && (CARD_WIDGETS as readonly string[]).includes(value);
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
		const clean: Partial<CardPrefs> = {};
		for (const key of CARD_WIDGETS) {
			const value = (prefs as Record<string, unknown>)[key];
			if (typeof value === 'boolean') clean[key] = value;
		}
		if (Object.keys(clean).length) out[hostId] = clean;
	}
	return out;
}
