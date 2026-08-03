/**
 * Card surface: what each widget renders, and what it calls back.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentRows, cardPrefs, historySeries, serviceOptions } from '@pdmux/core';
import CardSettingsPopover from '../src/components/CardSettingsPopover.svelte';
import HostCard from '../src/components/HostCard.svelte';
import HostSidebar from '../src/components/HostSidebar.svelte';
import MetricSparkline from '../src/components/MetricSparkline.svelte';
import ResourceRow from '../src/components/ResourceRow.svelte';
import ServiceLauncher from '../src/components/ServiceLauncher.svelte';
import UsageGaugeRow from '../src/components/UsageGaugeRow.svelte';

afterEach(cleanup);

const NOW = 1_800_000_000_000;

const AGENTS = agentRows(
	[
		{
			provider: 'claude',
			processes: 3,
			ts: NOW / 1000 - 60,
			windows: [
				{ key: 'session', label: '5h', usedPct: 18, remainingPct: 82 },
				{ key: 'weekly', label: '7d', usedPct: 45, remainingPct: 55 },
			],
		},
		{ provider: 'codex', processes: 1, ts: NOW / 1000, windows: [{ key: 'weekly', remainingPct: 15 }] },
	],
	['claude', 'codex'],
	NOW,
);

/**
 * Is the reachability glyph a JOINED link, or a parted one?
 *
 * The three states are one chain-link drawing in three conditions, and the connector
 * between the two arcs is what separates "connected" from "disconnected". Reading it here
 * rather than reading the colour is deliberate: the colour was the ONLY channel when this
 * was a disc, and a test that reads the hue would pass just as happily if all three states
 * drew the identical shape — which is the failure being guarded against.
 */
function joinedBar(dot: Element | null | undefined): boolean {
	return [...(dot?.querySelectorAll('path') ?? [])].some((path) => (path.getAttribute('d') ?? '').includes('M8 12h8'));
}

const SERVICES = serviceOptions([
	{ id: 'api', label: 'api', url: 'https://api.test', status: 'down' },
	{ id: 'web', label: 'web', url: 'https://web.test', status: 'up' },
]);

describe('[TC-PDUI-001] a host card renders only the widgets its preferences allow', () => {
	it('shows every widget by default and calls back for settings', () => {
		const onOpenSettings = vi.fn();
		const { container } = render(HostCard, {
			props: {
				host: { id: 'h1', name: 'alpha', state: 'online' },
				agents: AGENTS,
				resources: { cpuPct: 91, memPct: 47, diskPct: 80, memHint: '7.0Gi/15Gi' },
				services: SERVICES,
				now: NOW / 1000,
				onOpenSettings,
			},
		});
		expect(container.querySelector('[data-pdmux-name]')?.textContent).toBe('alpha');
		for (const widget of ['agents', 'resources', 'links']) {
			expect(container.querySelector(`[data-pdmux-widget="${widget}"]`)).not.toBeNull();
		}
		// The busy/idle chip is still gone: it only restated the agent count in colour.
		expect(container.querySelector('.pdmux-badge')).toBeNull();
		// Reachability is drawn for a running host too — a card with no mark at all cannot be
		// told from one whose mark failed to render.
		const dot = container.querySelector('.pdmux-state-dot');
		expect(dot?.getAttribute('data-pdmux-reach')).toBe('online');
		// A JOINED link: two arcs and the bar between them. The bar is the whole difference
		// from `offline`, so an assertion on the state attribute alone would not have seen
		// the two states render the same picture.
		expect(joinedBar(dot)).toBe(true);
		fireEvent.click(container.querySelector('.pdmux-cog') as HTMLElement);
		expect(onOpenSettings).toHaveBeenCalledWith('h1', expect.anything());
	});


	it('[TC-PDUI-177] hides a widget the preferences switch off, and marks a stopped host', () => {
		const prefs = { ...cardPrefs({}, 'h1'), resources: false };
		const { container } = render(HostCard, {
			props: { host: { id: 'h1', name: 'alpha', state: 'offline' }, agents: AGENTS, prefs, services: SERVICES },
		});
		expect(container.querySelector('[data-pdmux-widget="resources"]')).toBeNull();
		expect(container.querySelector('[data-pdmux-widget="agents"]')).not.toBeNull();
		const dot = container.querySelector('.pdmux-state-dot');
		expect(dot?.getAttribute('data-pdmux-reach')).toBe('offline');
		// ⚠ NEVER COLOUR ALONE. The state name has to survive for a reader who cannot
		// separate the hues — that is the whole reason the word chip was kept when the
		// busy/idle one was dropped.
		expect(dot?.getAttribute('aria-label')).toBe('stopped');
		expect(dot?.getAttribute('title')).toBe('stopped');
		// ⚠ AND NOT THE SAME PICTURE AS `online`. The colour swap is the accent; the link is
		// PARTED, which is what stays legible in greyscale and at a glance.
		expect(joinedBar(dot)).toBe(false);
		// Offline means every URL on the host is dead, so the launcher is disabled.
		expect((container.querySelector('.pdmux-launcher select') as HTMLSelectElement).disabled).toBe(true);
	});


/**
 * The mark that says an agent is behind — the one place a person looking at the
 * sidebar all day learns a release happened.
 *
 * ⚠ THESE USED TO SIT UNDER `[TC-PDUI-001]`, WHICH IS ABOUT PREFERENCES. The row is
 * not preference-driven, so the declaration that was counting them said nothing about
 * what they measure — the drift the matrix exists to catch, hiding inside a tag that
 * made the gate pass.
 */
describe('[TC-PDUI-202] a host card says when its agent has somewhere to go', () => {
	/**
	 * ⚠ THE ABSENCE IS THE ASSERTION. A row that always rendered would be the deleted
	 * busy/idle chip returning by the front door — the whole reason that chip went is
	 * that it spent card height restating something already on screen. A fleet with
	 * nothing to update must pay nothing.
	 */
	it('says nothing about the agent when there is nothing to say', () => {
		const { container } = render(HostCard, {
			props: { host: { id: 'h1', name: 'alpha', state: 'online' }, agents: AGENTS, services: SERVICES },
		});
		expect(container.querySelector('[data-pdmux-update]')).toBeNull();
		// And it is still not the class that test above forbids.
		expect(container.querySelector('.pdmux-badge')).toBeNull();
	});

	it('offers an update as a word, not as a colour, and hands back the anchor', () => {
		const onUpdateAgent = vi.fn();
		const { container } = render(HostCard, {
			props: {
				host: { id: 'h1', name: 'alpha', state: 'online', update: { kind: 'offer', label: 'Update available — 0.1.7' } },
				agents: AGENTS,
				services: SERVICES,
				onUpdateAgent,
			},
		});

		const control = container.querySelector('button.pdmux-card-update');
		expect(control).not.toBeNull();
		// The state travels in the accessible name as well as the visible text, so the
		// card still works in greyscale and to a screen reader — the rule the
		// reachability mark survived by and the chip did not.
		expect(control?.getAttribute('aria-label')).toBe('Update available — 0.1.7');
		expect(control?.getAttribute('title')).toBe('Update available — 0.1.7');
		expect(control?.textContent).toContain('0.1.7');

		fireEvent.click(control as HTMLElement);
		expect(onUpdateAgent).toHaveBeenCalledWith('h1', expect.anything());
	});

	/**
	 * The `onAddHost` law: a control that leads to a 403 is worse than no control. A
	 * member who cannot update anything is shown nothing to press.
	 */
	it('draws no control when the caller cannot act', () => {
		const { container } = render(HostCard, {
			props: {
				host: { id: 'h1', name: 'alpha', state: 'online', update: { kind: 'offer', label: 'Update available — 0.1.7' } },
				agents: AGENTS,
				services: SERVICES,
			},
		});
		expect(container.querySelector('[data-pdmux-update]')).toBeNull();
	});

	/**
	 * ⚠ NOT A DISABLED BUTTON. "Disabled" is a promise the DOM can be talked out of —
	 * by a stray `removeAttribute`, by a library, by a future refactor. A readout that
	 * is not a button cannot be pressed twice because there is nothing to press.
	 */
	it('reports a job in flight without offering a second one', () => {
		const onUpdateAgent = vi.fn();
		const { container } = render(HostCard, {
			props: {
				host: { id: 'h1', name: 'alpha', state: 'online', update: { kind: 'busy', label: 'Updating — restarting' } },
				agents: AGENTS,
				services: SERVICES,
				onUpdateAgent,
			},
		});

		const mark = container.querySelector('[data-pdmux-update="busy"]');
		expect(mark).not.toBeNull();
		expect(container.querySelector('button.pdmux-card-update')).toBeNull();
		expect(mark?.getAttribute('role')).toBe('img');
		// No percentage: `updateProgressPct` only counts while downloading and pins to
		// 100 for the rest, so a number here would sit frozen where nobody watches it.
		expect(mark?.textContent).not.toMatch(/%/);
	});

	/**
	 * ⚠ THREE SHAPES, NOT ONE SHAPE IN THREE COLOURS. This is the assertion that fails
	 * when somebody "simplifies" the icons — the same guard `joinedBar` gives the
	 * reachability mark, and the reason that mark survived while the chip did not.
	 * `urgent` is not a red `offer`: outdated is advisory, incompatible means the host
	 * already cannot talk to this server.
	 */
	it('draws a different silhouette for each kind', () => {
		const paths = (kind: 'offer' | 'urgent' | 'busy'): string => {
			const { container } = render(HostCard, {
				props: {
					host: { id: 'h1', name: 'alpha', state: 'online', update: { kind, label: `mark ${kind}` } },
					agents: AGENTS,
					services: SERVICES,
					onUpdateAgent: vi.fn(),
				},
			});
			return [...(container.querySelector('[data-pdmux-update]')?.querySelectorAll('path') ?? [])]
				.map((path) => path.getAttribute('d'))
				.join('|');
		};

		const drawings = new Set([paths('offer'), paths('urgent'), paths('busy')]);
		expect(drawings.size).toBe(3);
	});
});

/**
 * ⚠ THE SHAPE IS THE CHANNEL, NOT THE COLOUR — and `unknown` is the case that proves
 * it. A disabled host is one nobody is asking; collapsing it into `offline` reports a
 * switched-off machine as a broken one, and a reader who cannot separate the hues gets
 * nothing at all from a colour swap.
 *
 * Declared against `[TC-PDUI-176]`/`[TC-PDUI-177]` in the matrix all along. They sat
 * under `[TC-PDUI-001]`, which is about preferences, so the tag that answered for them
 * described something else — and the matrix's own claim that this file covers them was
 * not true of any tag in it.
 */
describe('[TC-PDUI-177] a card says reachability with a picture, not only a colour', () => {
	it('keeps disabled distinct from unreachable', () => {
		// `unknown` is a disabled host — nobody is asking it anything. Collapsing it into
		// `offline` would report a switched-off machine as a broken one.
		const { container } = render(HostCard, {
			props: { host: { id: 'h1', name: 'alpha', state: 'unknown' }, agents: AGENTS, services: SERVICES },
		});
		const dot = container.querySelector('.pdmux-state-dot');
		expect(dot?.getAttribute('data-pdmux-reach')).toBe('unknown');
		expect(dot?.getAttribute('aria-label')).toBe('unknown');
		// It draws the JOINED link and the stylesheet dashes it: a host nobody is asking is
		// not being reported as disconnected. The dash is a texture on the same path, which
		// is why the shape here matches `online` and not `offline` — and why the browser
		// spec, not this one, is where the dashing itself is checked (jsdom loads no CSS).
		expect(joinedBar(dot)).toBe(true);
	});

});

describe('[TC-PDUI-176] a long host name stays on one line and stays readable', () => {
	it('keeps a long host name on one line and reachable in full', () => {
		// The header had no rule for the name at all: a multi-word label wrapped and grew
		// the card, and one long unbroken token overflowed it (a flex item defaults to
		// `min-width: auto`, so the span would not shrink).
		const name = 'ip-10-0-12-233.ap-northeast-2.compute.internal';
		const { container } = render(HostCard, { props: { host: { id: 'h1', name, state: 'online' } } });
		const label = container.querySelector('[data-pdmux-name]') as HTMLElement;
		// Truncation hides the text, so the full value must stay somewhere reachable.
		expect(label.getAttribute('title')).toBe(name);
		expect(label.textContent).toBe(name);
	});
});
});

describe('[TC-PDUI-002] a gauge row draws remaining budget and omits unreported windows', () => {
	it('renders one gauge per reported window and flags the low one', () => {
		const { container } = render(UsageGaugeRow, { props: { row: AGENTS[0]!, windowLabels: { session: '5h' } } });
		const windows = [...container.querySelectorAll('[data-pdmux-window]')].map((n) =>
			n.getAttribute('data-pdmux-window'),
		);
		expect(windows).toEqual(['session', 'weekly']);
		expect(container.querySelector('.pdmux-agent-count')?.textContent).toBe('3');
		expect(container.querySelector('[data-pdmux-window="session"] .pdmux-fill')?.getAttribute('width')).toBe('82.00');

		const codex = render(UsageGaugeRow, { props: { row: AGENTS[1]! } });
		// The provider reports one window only — an empty second gauge would promise
		// data that will never arrive.
		expect(codex.container.querySelectorAll('[data-pdmux-window]')).toHaveLength(1);
		expect(codex.container.querySelector('.pdmux-fill')?.classList.contains('pdmux-low')).toBe(true);
	});

	it('says so when nothing was reported, and dims a stale snapshot', () => {
		const none = agentRows([], ['claude'], NOW)[0]!;
		const { container } = render(UsageGaugeRow, { props: { row: none } });
		expect(container.querySelector('[data-pdmux-empty="usage"]')?.textContent).toContain('no budget');
		expect(container.querySelector('.pdmux-gauge')).toBeNull();

		const stale = agentRows(
			[{ provider: 'claude', processes: 1, ts: NOW / 1000 - 3 * 3600, windows: [{ key: 'weekly', remainingPct: 40 }] }],
			['claude'],
			NOW,
		)[0]!;
		const dim = render(UsageGaugeRow, { props: { row: stale } });
		expect(dim.container.querySelector('.pdmux-row')?.classList.contains('pdmux-stale')).toBe(true);
	});
});

describe('[TC-PDUI-003] a resource row is a dash when unmeasured and red at the threshold', () => {
	it('renders the value and only draws a sparkline when there is history', () => {
		const now = 1_800_000_000;
		const samples = historySeries({ t: [now - 60, now - 30, now], hosts: [{ id: 'h1', cpu: [10, 85, 90] }] }, 'h1').cpu;
		const hot = render(ResourceRow, { props: { label: 'CPU', pct: 91, samples, now } });
		expect(hot.container.querySelector('.pdmux-metric-value')?.textContent).toBe('91%');
		expect(hot.container.querySelector('.pdmux-metric-value')?.classList.contains('pdmux-hot')).toBe(true);
		expect(hot.container.querySelector('svg.pdmux-spark')).not.toBeNull();

		const unknown = render(ResourceRow, { props: { label: 'CPU', pct: null } });
		expect(unknown.container.querySelector('.pdmux-metric-value')?.textContent).toBe('—');
		expect(unknown.container.querySelector('.pdmux-metric-value')?.classList.contains('pdmux-hot')).toBe(false);
		// No history yet: draw no box at all rather than an empty one, which reads as
		// broken.
		expect(unknown.container.querySelector('svg.pdmux-spark')).toBeNull();
	});

	it('adds the red band only when a value actually reaches it', () => {
		const now = 1_800_000_000;
		const cool = render(MetricSparkline, {
			props: { samples: [{ t: now - 30, v: 20 }, { t: now, v: 30 }], now },
		});
		expect(cool.container.querySelectorAll('.pdmux-line.pdmux-hot')).toHaveLength(0);
		const hot = render(MetricSparkline, {
			props: { samples: [{ t: now - 30, v: 20 }, { t: now, v: 95 }], now },
		});
		expect(hot.container.querySelectorAll('.pdmux-line.pdmux-hot').length).toBeGreaterThan(0);
		// A gap must never be joined by a straight line: two runs, two paths.
		const gapped = render(MetricSparkline, {
			props: { samples: [{ t: now - 60, v: 20 }, { t: now - 30, v: null }, { t: now, v: 30 }], now },
		});
		expect(gapped.container.querySelectorAll('path.pdmux-line')).toHaveLength(2);
	});
});

describe('[TC-PDUI-004] the launcher opens the selected service', () => {
	it('preselects the first live service and reports the URL through a callback', async () => {
		const onOpen = vi.fn();
		const { container } = render(ServiceLauncher, { props: { options: SERVICES, onOpen } });
		const select = container.querySelector('select') as HTMLSelectElement;
		expect(select.value).toBe('https://web.test'); // the first one that is up
		fireEvent.click(container.querySelector('button') as HTMLElement);
		expect(onOpen).toHaveBeenCalledWith('https://web.test');

		// Enter opens too: after choosing with the keyboard the select has focus, and
		// demanding a Tab to the button is a trap.
		await fireEvent.change(select, { target: { value: 'https://api.test' } });
		await fireEvent.keyDown(select, { key: 'Enter' });
		expect(onOpen).toHaveBeenLastCalledWith('https://api.test');
	});

	it('opens nothing while the host is unreachable', () => {
		const onOpen = vi.fn();
		const { container } = render(ServiceLauncher, { props: { options: SERVICES, disabled: true, onOpen } });
		fireEvent.click(container.querySelector('button') as HTMLElement);
		expect(onOpen).not.toHaveBeenCalled();
	});
});

describe('[TC-PDUI-005] the settings popover toggles one card', () => {
	it('reports each toggle, and says only what the card cannot', () => {
		const onToggle = vi.fn();
		const { container } = render(CardSettingsPopover, {
			props: {
				hostName: 'alpha',
				prefs: { agents: true, resources: false, links: true },
				status: 'online · 2026-08-02 11:04',
				onToggle,
			},
		});
		expect(container.querySelector('.pdmux-popover-title')?.textContent).toBe('alpha');
		expect(container.querySelector('[data-pdmux-status]')?.textContent).toContain('online');

		const resources = container.querySelector('[data-pdmux-toggle="resources"]') as HTMLInputElement;
		expect(resources.checked).toBe(false);
		fireEvent.change(resources);
		expect(onToggle).toHaveBeenCalledWith('resources');

		// Clamped into the viewport, so opening near an edge still shows the whole box.
		const style = (container.querySelector('.pdmux-popover') as HTMLElement).style;
		expect(Number.parseInt(style.left, 10)).toBeGreaterThanOrEqual(8);
	});

	it('[TC-PDUI-005] carries no reference rows, because the host page already does', () => {
		/**
		 * ⚠ THE ABSENCE IS THE ASSERTION. The panel grew to fifteen rows — address,
		 * agent version, os/arch, last seen and a copyable `ssh` line, then six action
		 * buttons — and all but the three switches were a second copy of the host's own
		 * page, two of them down to the same testid. A 260px panel beside a card is an
		 * entry point, not a container; this keeps it one.
		 */
		const { container } = render(CardSettingsPopover, {
			props: { hostName: 'alpha', prefs: { agents: true, resources: true, links: true } },
		});
		expect(container.querySelector('[data-pdmux-details]')).toBeNull();
		// And with no status given, the line is absent rather than empty — an empty
		// element still costs a row of height under the name.
		expect(container.querySelector('[data-pdmux-status]')).toBeNull();
		// The switches are still all there; this is a removal, not a reduction of them.
		expect(container.querySelectorAll('[data-pdmux-toggle]')).toHaveLength(3);
	});
});

describe('[TC-PDUI-006] the sidebar lists cards and says when there are none', () => {
	it('renders one card per entry', () => {
		const { container } = render(HostSidebar, {
			props: {
				cards: [
					{ host: { id: 'h1', name: 'alpha' }, agents: AGENTS, services: SERVICES },
					{ host: { id: 'h2', name: 'beta' } },
				],
			},
		});
		expect(container.querySelectorAll('[data-pdmux-host]')).toHaveLength(2);
		expect(screen.getByText('beta')).toBeTruthy();
		expect(container.querySelector('[data-pdmux-empty="hosts"]')).toBeNull();
	});

	it('shows an empty state instead of a blank column', () => {
		const { container } = render(HostSidebar, { props: { cards: [] } });
		expect(container.querySelector('[data-pdmux-empty="hosts"]')?.textContent).toContain('No hosts');
	});
});

describe('[TC-PDUI-007] the sidebar offers a footer slot the app fills', () => {
	it('renders the snippet last, inside the pinned slot', () => {
		// The package supplies the slot and its geometry; an account block (or anything
		// else app-shaped) stays out of here on purpose.
		const { container } = render(HostSidebar, {
			props: { cards: [{ host: { id: 'h1', name: 'alpha' } }], footer: createRawSnippet(() => ({ render: () => '<b data-app-footer>me</b>' })) },
		});
		const slot = container.querySelector('[data-pdmux-sidebar-foot]');
		expect(slot?.querySelector('[data-app-footer]')?.textContent).toBe('me');
		// Last child: it is the bottom of the column, after every card.
		expect(container.querySelector('.pdmux-sidebar')?.lastElementChild).toBe(slot);
	});

	it('adds nothing when the app supplies no footer', () => {
		const { container } = render(HostSidebar, { props: { cards: [] } });
		expect(container.querySelector('[data-pdmux-sidebar-foot]')).toBeNull();
	});
});

describe('[TC-PDUI-194] the sidebar ends with a way to add a host', () => {
	it('sits after the last card', () => {
		const { container } = render(HostSidebar, {
			props: {
				cards: [{ host: { id: 'h1', name: 'alpha' } }, { host: { id: 'h2', name: 'beta' } }],
				onAddHost: () => {},
			},
		});
		const tiles = [...container.querySelectorAll('[data-pdmux-host], [data-pdmux-add-host]')];
		expect(tiles).toHaveLength(3);
		expect(tiles[2]?.hasAttribute('data-pdmux-add-host')).toBe(true);
	});

	/**
	 * The case the tile exists for. An empty fleet renders the "no hosts yet" line, and
	 * on its own that is a dead end — the only way out was a 28px glyph in the header.
	 * If this ever regresses to living inside the `{#each}`, this is the assertion that
	 * notices; the one above would keep passing.
	 */
	it('is there when there are no cards at all, beside the empty line', () => {
		const { container } = render(HostSidebar, { props: { cards: [], onAddHost: () => {} } });
		expect(container.querySelector('[data-pdmux-empty="hosts"]')).toBeTruthy();
		expect(container.querySelector('[data-pdmux-add-host]')).toBeTruthy();
	});

	it('calls back when pressed, and takes its label from the translator', () => {
		let called = 0;
		const { container } = render(HostSidebar, {
			props: { cards: [], onAddHost: () => (called += 1), t: (_key: string, fallback: string) => `[${fallback}]` },
		});
		const tile = container.querySelector('[data-pdmux-add-host]') as HTMLButtonElement;
		expect(tile.textContent).toContain('[Add host]');
		tile.click();
		expect(called).toBe(1);
	});

	// No callback means no permission to change the fleet, and a control that answers
	// 403 is worse than no control.
	it('is absent when the app passes no handler', () => {
		const { container } = render(HostSidebar, { props: { cards: [{ host: { id: 'h1', name: 'alpha' } }] } });
		expect(container.querySelector('[data-pdmux-add-host]')).toBeNull();
	});
});

describe('[TC-PDUI-031] every user-facing string can be replaced by the consumer', () => {
	it('routes text through the optional translator', () => {
		const t = (key: string, fallback: string): string => `[${key}]${fallback}`;
		const { container } = render(HostSidebar, { props: { cards: [], t } });
		expect(container.querySelector('[data-pdmux-empty="hosts"]')?.textContent).toContain('[pdmux.sidebar.empty]');
		const launcher = render(ServiceLauncher, { props: { options: SERVICES, t } });
		expect(launcher.container.querySelector('button')?.textContent).toContain('[pdmux.services.open]');
	});
});
