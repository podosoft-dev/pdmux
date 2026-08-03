<script lang="ts">
	/**
	 * Choose what a cell points at: an existing session, a new one, or a bare shell.
	 *
	 * Opened from a cell it RETARGETS that cell; opened from the "add" affordance it
	 * fills the first empty one. Clicks inside are stopped from bubbling: re-rendering
	 * (picking another host) detaches the clicked node, and an outside-click handler
	 * would then read that as a click outside and close the popover mid-interaction.
	 */
	import { nextSessionName } from '@pdmux/core';
	import { type Translate, translator } from '../i18n.js';
	import type { PickerHost, PickerTarget } from '../types.js';

	interface Props {
		hosts?: readonly PickerHost[];
		/** Cell the picker was opened from; null means "the first empty one". */
		index?: number | null;
		/** Host to preselect — usually the one already in that cell. */
		hostId?: string | null;
		/** Session names already claimed by other cells, so a new name is free. */
		taken?: readonly string[];
		anchor?: { x: number; y: number };
		width?: number;
		t?: Translate;
		onApply?: (target: PickerTarget, index: number | null) => void;
		onCancel?: () => void;
	}

	let { hosts = [], index = null, hostId = null, taken = [], anchor = { x: 8, y: 8 }, width = 310, t, onApply, onCancel }: Props =
		$props();

	const tr = $derived(translator(t));
	let selectedHost = $state<string | null>(null);
	const host = $derived(
		hosts.find((h) => h.id === (selectedHost ?? hostId)) ?? hosts.find((h) => h.online) ?? hosts[0] ?? null,
	);
	const sessions = $derived(host?.sessions ?? []);
	/**
	 * Only `false` when the host positively reported no multiplexer — see PickerHost.
	 *
	 * ⚠ THIS IS WHY THE PICKER USED TO OFFER SOMETHING THE AGENT WOULD REFUSE. A host
	 * without a multiplexer showed "No sessions running", identical to a host whose
	 * sessions had merely exited, and "New session" stayed enabled — so the only way
	 * to learn the truth was to click it and read an error.
	 */
	const hasMux = $derived(host?.multiplexer !== false);
	const gridHosts = $derived(hosts.map((h) => ({ id: h.id, name: h.name, online: h.online, sessions: h.sessions })));
	let name = $state('');
	const suggestion = $derived(host ? nextSessionName(gridHosts, host.id, taken) : 'w1');
	const proposed = $derived(name.trim() || suggestion);
	// The same rule the server enforces, so an invalid name never leaves the page.
	const valid = $derived(/^[A-Za-z0-9_-]{1,32}$/.test(proposed));

	let box = $state<HTMLDivElement | null>(null);
	/**
	 * Bound rather than read once.
	 *
	 * The clamp used to read `globalThis.innerWidth` inside a `$derived` with nothing to
	 * invalidate it, so a phone rotated with the popover open kept a position computed for
	 * the old viewport. Binding makes the window a reactive input, which is the only way
	 * this recomputes on rotation or a keyboard opening.
	 */
	let viewportW = $state(typeof globalThis.innerWidth === 'number' ? globalThis.innerWidth : 0);
	let viewportH = $state(typeof globalThis.innerHeight === 'number' ? globalThis.innerHeight : 0);

	/**
	 * Never wider than the screen. A fixed 320px-ish box on a 320px phone hung off
	 * the right edge, because the clamp below can only MOVE the box — it cannot shrink one.
	 */
	const boxWidth = $derived(viewportW > 0 ? Math.min(width, viewportW - 16) : width);

	const position = $derived.by(() => {
		const w = box?.offsetWidth || boxWidth;
		const h = box?.offsetHeight || 320;
		const screenW = viewportW || w + 16;
		const screenH = viewportH || h + 16;
		return {
			left: Math.max(8, Math.min(anchor.x, screenW - w - 8)),
			top: Math.max(8, Math.min(anchor.y, screenH - h - 8)),
		};
	});

	function apply(target: PickerTarget): void {
		onApply?.(target, index);
	}
</script>

<svelte:window bind:innerWidth={viewportW} bind:innerHeight={viewportH} />

<div
	class="pdmux pdmux-popover"
	bind:this={box}
	role="dialog"
	tabindex="-1"
	aria-label={tr('pdmux.picker.title', 'Choose a terminal target')}
	data-pdmux-popover="target-picker"
	style="left:{position.left}px;top:{position.top}px;width:{boxWidth}px"
	onclick={(event) => event.stopPropagation()}
	onkeydown={(event) => {
		if (event.key === 'Escape') onCancel?.();
	}}
>
	<div class="pdmux-popover-title">
		{index == null
			? tr('pdmux.picker.addTitle', 'Add a terminal')
			: `#${index + 1} ${tr('pdmux.picker.cellTitle', 'terminal target')}`}
	</div>

	<div class="pdmux-chiprow">
		{#each hosts as candidate (candidate.id)}
			<button
				class="pdmux-chip"
				type="button"
				aria-pressed={candidate.id === host?.id}
				disabled={!candidate.online}
				title={candidate.online ? candidate.name : tr('pdmux.picker.offline', 'not reachable')}
				data-pdmux-host={candidate.id}
				onclick={() => (selectedHost = candidate.id)}>{candidate.name}</button
			>
		{/each}
	</div>

	<div class="pdmux-meta">{tr('pdmux.picker.sessions', 'Existing sessions')} ({sessions.length})</div>
	{#each sessions as session (session.name)}
		<button
			class="pdmux-pick-row"
			type="button"
			data-pdmux-session={session.name}
			onclick={() => host && apply({ hostId: host.id, kind: 'attach', session: session.name })}
		>
			<span>{session.name}</span>
			<span class="pdmux-meta"
				>{session.attached ?? 0} {tr('pdmux.picker.clients', 'clients')} · {session.windows ?? 0}
				{tr('pdmux.picker.windows', 'windows')}</span
			>
		</button>
	{/each}
	{#if !sessions.length}
		<div class="pdmux-meta" data-pdmux-empty="sessions">
			{hasMux
				? tr('pdmux.picker.noSessions', 'No sessions running')
				: tr('pdmux.picker.noMux', 'This host has no terminal multiplexer installed')}
		</div>
	{/if}

	<div class="pdmux-meta">{tr('pdmux.picker.create', 'Create')}</div>
	<div class="pdmux-row">
		<button
			class="pdmux-pick-row"
			type="button"
			data-pdmux-action="new"
			disabled={!host || !valid || !hasMux}
			title={hasMux ? undefined : tr('pdmux.picker.noMux', 'This host has no terminal multiplexer installed')}
			onclick={() => host && valid && hasMux && apply({ hostId: host.id, kind: 'new', session: proposed })}
			>＋ {tr('pdmux.picker.newSession', 'New session')}</button
		>
		<input
			type="text"
			aria-label={tr('pdmux.picker.sessionName', 'session name')}
			placeholder={suggestion}
			bind:value={name}
			disabled={!hasMux}
			aria-invalid={!valid}
		/>
	</div>

	<button
		class="pdmux-pick-row"
		type="button"
		data-pdmux-action="shell"
		data-pdmux-only-option={hasMux ? undefined : 'true'}
		disabled={!host}
		onclick={() => host && apply({ hostId: host.id, kind: 'shell', session: null })}
	>
		<span>▸ {tr('pdmux.picker.shell', 'Plain shell (no multiplexer)')}</span>
		<span class="pdmux-meta">⚠ {tr('pdmux.picker.shellWarning', 'ends with the connection')}</span>
	</button>

	<button class="pdmux-btn" type="button" data-pdmux-action="cancel" onclick={() => onCancel?.()}
		>{tr('pdmux.picker.cancel', 'Cancel')}</button
	>
</div>
