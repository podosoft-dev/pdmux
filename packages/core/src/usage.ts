/**
 * Coding-agent budget gauges.
 *
 * The card answers one question: can I go and work on this host? A remaining-budget
 * gauge answers it directly — a long bar always means "plenty left", whichever way
 * the provider itself happens to report.
 */
import { type RelativeAge, relativeAge } from './time.js';

/**
 * How a provider id is written when a person reads it.
 *
 * The id is a wire value — lowercase, matched against a process name and echoed back to
 * the server — and it was being printed straight onto the card, so a product called
 * Claude appeared as "claude". The id must not change: it keys `data-pdmux-agent`, the
 * fleet setting and the protocol. Only the rendering does.
 *
 * The table is for names whose correct form is not simply a capital first letter, and it
 * is the only place in this package allowed to know a vendor writes itself a particular
 * way. Anything absent from it falls back to capitalising each word, which is right far
 * more often than lowercasing is — and is at least a considered guess rather than the raw
 * identifier.
 */
const PROVIDER_LABELS: Record<string, string> = {
	claude: 'Claude',
	codex: 'Codex',
	copilot: 'Copilot',
	cursor: 'Cursor',
	gemini: 'Gemini',
	aider: 'Aider',
};

/**
 * A provider id as a display name.
 *
 * Total, like everything else here: junk in gives an empty string rather than throwing,
 * because this runs inside a card that must keep rendering.
 */
export function providerLabel(id: unknown): string {
	const raw = typeof id === 'string' ? id.trim() : '';
	if (!raw) return '';
	const known = PROVIDER_LABELS[raw.toLowerCase()];
	if (known) return known;
	// `github-copilot` -> `Github Copilot`. Separators are normalised to spaces so a
	// fallback name reads as words rather than as an identifier.
	return raw
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}

/** Gauge user-space box. */
export const GAUGE = { w: 100, h: 10 } as const;

/** At/below this REMAINING percentage a gauge turns critical. */
export const LOW_REMAINING_PCT = 20;

/** A snapshot older than this is dimmed — the reporter may have stopped. */
export const USAGE_STALE_MS = 2 * 60 * 60_000;

export interface GaugeCell {
	/** Rounded remaining 0..100, or null when the provider reported nothing. */
	pct: number | null;
	/** Bar width in gauge user space. 0 for unknown — an empty track, never 0%. */
	width: number;
	low: boolean;
}

/**
 * One remaining-budget gauge.
 *
 * `null` must render as an empty track, never as 0%: "no data" and "almost out" are
 * opposite situations and only one of them is urgent.
 */
export function gaugeCell(remaining: unknown): GaugeCell {
	const pct =
		typeof remaining === 'number' && Number.isFinite(remaining)
			? Math.max(0, Math.min(100, Math.round(remaining)))
			: null;
	return {
		pct,
		width: pct == null ? 0 : (pct * GAUGE.w) / 100,
		low: pct != null && pct <= LOW_REMAINING_PCT,
	};
}

/** How old an agent snapshot is, and whether to dim it. */
export function usageAge(ts: unknown, now: number): RelativeAge {
	return relativeAge(ts, now, USAGE_STALE_MS);
}

/** One usage window as it arrives from a provider adapter. */
export interface UsageWindowInput {
	key: string;
	label?: string | null;
	usedPct?: number | null;
	remainingPct?: number | null;
	/** Epoch seconds. A window whose reset already passed describes a spent window. */
	resetsAt?: number | null;
}

export interface AgentUsageInput {
	provider: string;
	processes?: number | null;
	ts?: number | null;
	windows?: UsageWindowInput[] | null;
}

export interface AgentWindowRow extends GaugeCell {
	key: string;
	label: string | null;
	/**
	 * Both polarities travel: providers disagree (one shows what is left, the other
	 * what is spent) and a tooltip should be comparable with the provider's own UI.
	 */
	usedPct: number;
	remainingPct: number;
}

export interface AgentRow {
	provider: string;
	/** Live process count for that provider. */
	processes: number;
	ts: number | null;
	age: RelativeAge;
	/** Only windows the provider actually reported and that have not reset. */
	windows: AgentWindowRow[];
}

/**
 * One agent's row.
 *
 * Two rules were learned the hard way:
 *  - a window the provider does not report is ABSENT, not an empty gauge. One agent
 *    exposes a weekly limit and no session one, so an empty session gauge on its row
 *    was a promise that could never be kept.
 *  - a window whose `resetsAt` has passed is DROPPED. A nine-day-old snapshot kept
 *    claiming "95% left" while the live account was at 70%.
 */
export function agentRow(usage: unknown, now: number): AgentRow {
	const input = (usage && typeof usage === 'object' ? usage : {}) as Partial<AgentUsageInput>;
	const processes =
		typeof input.processes === 'number' && input.processes >= 0 ? Math.trunc(input.processes) : 0;
	const ts = typeof input.ts === 'number' && Number.isFinite(input.ts) ? input.ts : null;
	const windows: AgentWindowRow[] = [];
	for (const raw of Array.isArray(input.windows) ? input.windows : []) {
		const win = (raw && typeof raw === 'object' ? raw : {}) as Partial<UsageWindowInput>;
		if (typeof win.key !== 'string' || !win.key) continue;
		if (typeof win.resetsAt === 'number' && win.resetsAt > 0 && win.resetsAt * 1000 <= now) continue;
		const cell = gaugeCell(win.remainingPct);
		if (cell.pct == null) continue; // not reported -> not rendered
		const usedPct = typeof win.usedPct === 'number' ? Math.round(win.usedPct) : 100 - cell.pct;
		windows.push({
			...cell,
			key: win.key,
			label: typeof win.label === 'string' && win.label ? win.label : null,
			usedPct,
			remainingPct: cell.pct,
		});
	}
	return {
		provider: typeof input.provider === 'string' ? input.provider : '',
		processes,
		ts,
		age: usageAge(ts, now),
		windows,
	};
}

/**
 * Rows for a fixed provider order, so two cards can be compared line by line.
 * A provider with no snapshot still gets a row (0 processes, no windows) — the card
 * says "nothing reported" rather than silently dropping the agent.
 */
export function agentRows(usage: unknown, providers: readonly string[], now: number): AgentRow[] {
	const list = Array.isArray(usage) ? (usage as AgentUsageInput[]) : [];
	return providers.map((provider) => {
		const found = list.find((u) => u && u.provider === provider);
		return { ...agentRow(found ?? { provider }, now), provider };
	});
}
