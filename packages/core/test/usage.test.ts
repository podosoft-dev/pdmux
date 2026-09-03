/**
 * Agent budget gauges and snapshot age.
 */
import { describe, expect, it } from 'vitest';
import {
	CARD_WIDGETS,
	type CardPrefsMap,
	GAUGE,
	agentRow,
	agentRows,
	cardCollapsed,
	cardPrefs,
	gaugeCell,
	providerLabel,
	sanitizeCardPrefs,
	toggleCardCollapsed,
	toggleCardWidget,
	usageAge,
} from '../src/index.js';

const NOW = 1_800_000_000_000; // epoch ms — a plausible clock, so ages stay positive

describe('[TC-PDCORE-045] a gauge draws remaining budget and flags the last fifth', () => {
	it('is proportional, clamped, and empty (never 0%) when unknown', () => {
		expect(gaugeCell(100)).toEqual({ pct: 100, width: GAUGE.w, low: false });
		expect(gaugeCell(50)).toEqual({ pct: 50, width: GAUGE.w / 2, low: false });
		expect(gaugeCell(21).low).toBe(false);
		expect(gaugeCell(20).low).toBe(true); // the boundary IS critical
		expect(gaugeCell(0)).toEqual({ pct: 0, width: 0, low: true }); // 0% left is urgent
		for (const junk of [null, undefined, 'x', Number.NaN, {}]) {
			expect(gaugeCell(junk)).toEqual({ pct: null, width: 0, low: false });
		}
		expect(gaugeCell(140).width).toBe(GAUGE.w);
		expect(gaugeCell(-5).pct).toBe(0);
	});
});

describe('[TC-PDCORE-046] a row only carries windows the provider really reported', () => {
	it('keeps both polarities and drops unreported windows', () => {
		const row = agentRow(
			{
				provider: 'claude',
				processes: 2,
				ts: NOW / 1000 - 300,
				windows: [
					{ key: 'session', label: 'session', usedPct: 70, remainingPct: 30 },
					{ key: 'weekly', remainingPct: null },
				],
			},
			NOW,
		);
		expect(row.processes).toBe(2);
		expect(row.windows).toHaveLength(1);
		expect(row.windows[0]).toMatchObject({ key: 'session', remainingPct: 30, usedPct: 70, low: false });
		// An agent nothing was reported for: zero processes, no windows, no claim.
		const empty = agentRow({ provider: 'codex' }, NOW);
		expect([empty.processes, empty.windows.length, empty.ts]).toEqual([0, 0, null]);
		for (const junk of [null, {}, { provider: 7, processes: 'x', windows: 9 }]) {
			expect(agentRow(junk, NOW).processes).toBe(0);
		}
	});

	it('drops a window whose reset already passed', () => {
		// A nine-day-old snapshot kept claiming "95% left" while the live account was
		// at 70%: that number described a window that had already reset.
		const rows = agentRows(
			[
				{
					provider: 'codex',
					processes: 1,
					ts: NOW / 1000,
					windows: [
						{ key: 'weekly', remainingPct: 95, resetsAt: NOW / 1000 - 60 },
						{ key: 'session', remainingPct: 15, resetsAt: NOW / 1000 + 60 },
					],
				},
			],
			['claude', 'codex'],
			NOW,
		);
		expect(rows.map((r) => r.provider)).toEqual(['claude', 'codex']); // fixed order
		expect(rows[0]!.windows).toEqual([]); // no snapshot at all
		expect(rows[1]!.windows.map((w) => w.key)).toEqual(['session']);
		expect(rows[1]!.windows[0]!.low).toBe(true);
		// The provider's own polarity is derived when it only reports one side.
		expect(rows[1]!.windows[0]!.usedPct).toBe(85);
	});
});

describe('[TC-PDCORE-047] a snapshot says how old it is, and dims past two hours', () => {
	it('buckets on the raw age, not on rounded minutes', () => {
		// Rounding first made a 30-second-old snapshot claim it was "1 minute" old.
		expect(usageAge(NOW / 1000 - 30, NOW)).toMatchObject({ known: true, unit: 'now', value: 0, stale: false });
		expect(usageAge(NOW / 1000 - 300, NOW)).toMatchObject({ unit: 'minute', value: 5, stale: false });
		expect(usageAge(NOW / 1000 - 3 * 3600, NOW)).toMatchObject({ unit: 'hour', value: 3, stale: true });
		expect(usageAge(null, NOW)).toMatchObject({ known: false, stale: false });
		expect(usageAge(-5, NOW).known).toBe(false);
	});
});

describe('[TC-PDCORE-030] card widgets are per card, use safe defaults, and survive a reload', () => {
	it('toggles one card without touching another, and cleans junk on hydrate', () => {
		let cards = {};
		expect(cardPrefs(cards, 'h1')).toEqual({ agents: true, resources: true, links: false });
		cards = toggleCardWidget(cards, 'h1', 'resources');
		expect(cardPrefs(cards, 'h1').resources).toBe(false);
		expect(cardPrefs(cards, 'h2').resources).toBe(true);
		expect(toggleCardWidget(cards, 'h1', 'bogus')).toBe(cards);
		expect(toggleCardWidget(cards, '', 'agents')).toBe(cards);

		const reloaded = sanitizeCardPrefs(JSON.parse(JSON.stringify(cards)));
		expect(cardPrefs(reloaded, 'h1').resources).toBe(false);
		const dirty = sanitizeCardPrefs({ h1: { links: 'nope', agents: false }, '': {}, x: 5 });
		expect(cardPrefs(dirty, 'h1')).toEqual({ agents: false, resources: true, links: false });
		// A host that is not in this snapshot keeps its setting: a stopped host still
		// has a card, and one that comes back should not be reset.
		expect(cardPrefs(sanitizeCardPrefs({ ghost: { agents: false } }), 'ghost').agents).toBe(false);
		expect(cardPrefs(undefined, 'h1')).toEqual({ agents: true, resources: true, links: false });
		// An existing explicit choice is data, not a default. Upgrading must not hide
		// a launcher somebody deliberately enabled.
		expect(cardPrefs({ h1: { links: true } }, 'h1').links).toBe(true);
	});
});

describe('[TC-PDCORE-096] a card folds to its header, per host, and stays folded', () => {
	it('is not a widget, survives a hydrate, and outlives a widget toggle', () => {
		let cards: CardPrefsMap = {};
		expect(cardCollapsed(cards, 'h1')).toBe(false);
		expect(cardCollapsed(undefined, 'h1')).toBe(false);

		cards = toggleCardCollapsed(cards, 'h1');
		expect(cardCollapsed(cards, 'h1')).toBe(true);
		// Per card: the operator folds the host they rarely look at, not the column.
		expect(cardCollapsed(cards, 'h2')).toBe(false);
		expect(toggleCardCollapsed(cards, '')).toBe(cards);

		// ⚠ FOLDING IS NOT HIDING EVERY WIDGET. A folded card still remembers what it
		// shows when it opens again, so the two settings must not overwrite each other.
		expect(cardPrefs(cards, 'h1')).toEqual({ agents: true, resources: true, links: false });
		cards = toggleCardWidget(cards, 'h1', 'resources');
		expect(cardPrefs(cards, 'h1').resources).toBe(false);
		expect(cardCollapsed(cards, 'h1')).toBe(true);
		cards = toggleCardCollapsed(cards, 'h1');
		expect(cardCollapsed(cards, 'h1')).toBe(false);
		expect(cardPrefs(cards, 'h1').resources).toBe(false);

		// The reload path. Everything persisted goes through `sanitizeCardPrefs`, and it
		// DROPS keys it does not know — which is exactly how a fold would come back open.
		const reloaded = sanitizeCardPrefs(JSON.parse(JSON.stringify(toggleCardCollapsed(cards, 'h1'))));
		expect(cardCollapsed(reloaded, 'h1')).toBe(true);
		expect(cardPrefs(reloaded, 'h1').resources).toBe(false);
		// A row that carries nothing but the fold still has to be kept.
		expect(cardCollapsed(sanitizeCardPrefs({ lone: { collapsed: true } }), 'lone')).toBe(true);
		// …and junk is still junk.
		expect(cardCollapsed(sanitizeCardPrefs({ h1: { collapsed: 'yes' } }), 'h1')).toBe(false);
		expect(CARD_WIDGETS).not.toContain('collapsed');
	});
});

describe('[TC-PDCORE-090] a provider id is rendered as a name, never as the raw id', () => {
	it('writes the known agents the way they write themselves', () => {
		// The id is a wire value and stays lowercase; only the rendering changes.
		expect(providerLabel('claude')).toBe('Claude');
		expect(providerLabel('codex')).toBe('Codex');
	});

	it('capitalises an unknown provider instead of printing the identifier', () => {
		// A fleet setting can name anything. A considered guess beats the raw id, which is
		// what put a lowercase product name on the card in the first place.
		expect(providerLabel('gemini')).toBe('Gemini');
		expect(providerLabel('acme-cli')).toBe('Acme Cli');
		expect(providerLabel('some_tool')).toBe('Some Tool');
	});

	it('is total, because it runs inside a card that must keep rendering', () => {
		for (const junk of [null, undefined, 42, {}, '', '   ']) {
			expect(providerLabel(junk as unknown)).toBe('');
		}
	});

	it('does not alter the id itself', () => {
		// `data-pdmux-agent`, the fleet setting and the protocol all key off the raw value.
		const rows = agentRows([{ provider: 'claude', processes: 1 }], ['claude', 'codex'], NOW);
		expect(rows.map((row) => row.provider)).toEqual(['claude', 'codex']);
	});
});
