<script lang="ts">
	/**
	 * One terminal cell: header, live surface, and the click guard over it.
	 *
	 * TWO RULES KEEP TERMINALS ALIVE:
	 *  1. a pane is created ONCE per slot and never re-parented — moving the surface in
	 *     the DOM tears down its connection and loses the scrollback. Mode, page and
	 *     zoom only toggle visibility and CSS order.
	 *  2. becoming visible again re-fits the surface, so a pane that was hidden comes
	 *     back with the right geometry instead of a wrapped mess.
	 *
	 * The header is also the drag handle, and both gestures go through the same
	 * classifier: a quick still press zooms, anything longer or wider is a drag.
	 */
	import {
		type ClickAction,
		type HelperKeyId,
		type PointerSample,
		type TerminalSlot,
		ctrlChord,
		guardIntent,
		pressHelperKey,
		slotLabel,
		toProtocolTarget,
		type HistoryLine,
	} from '@pdmux/core';
	import { type Translate, translator } from '../i18n.js';
	import { writeClipboard } from '../adapters/terminal-surface.js';
	import TerminalComposer from './TerminalComposer.svelte';
	import TerminalKeyBar from './TerminalKeyBar.svelte';
	import TerminalHistory from './TerminalHistory.svelte';
	import type { TerminalAdapter, TerminalConnection } from '../adapters/terminal-adapter.js';
	import { type TerminalSurface, type TerminalSurfaceFactory, createXtermSurface } from '../adapters/terminal-surface.js';

	interface Props {
		slot: TerminalSlot;
		index: number;
		hostName: string;
		adapter: TerminalAdapter;
		/** Injectable so the wiring is testable without a canvas. */
		createSurface?: TerminalSurfaceFactory;
		reachable?: boolean;
		zoomed?: boolean;
		focused?: boolean;
		visible?: boolean;
		/**
		 * False while the whole grid is off screen — a narrow screen showing another tab.
		 * The pane stays MOUNTED (a `shell` target dies with its pane and an attached
		 * session loses its scrollback); this only stops it drawing, so it re-fits when it
		 * comes back.
		 */
	/**
	 * Is this the cell a single-column screen shows? Drives `data-pdmux-stack`, which
	 * the stylesheet reads below the stack breakpoint to show exactly one cell — so a
	 * narrow first paint looks like the hydrated screen even when the server guessed
	 * the device wrong (a resized window, a responsive-mode tab: no UA hint can know).
	 * `true` by default so a consumer that never stacks renders everything.
	 */
	stackAnchor?: boolean;
		onScreen?: boolean;
		/** Show the soft-keyboard helper row under the terminal. */
		keyBar?: boolean;
		/**
		 * True when the grid is showing exactly ONE cell — a phone's stacked shell, `tab`
		 * mode, a zoom. Then this pane IS the pane the user is looking at, which is what
		 * lets the touch bars appear without waiting for a tap (see `touchBar`).
		 */
		solo?: boolean;
		/** CSS order, so mounted panes stay in cell order without re-parenting. */
		order?: number;
		dragging?: boolean;
		dropTarget?: boolean;
		clickAction?: ClickAction;
		t?: Translate;
		onAssign?: (index: number, anchor: HTMLElement) => void;
		onZoom?: (slotId: string) => void;
		onFocus?: (slotId: string) => void;
		onClose?: (index: number) => void;
		onDetach?: (slot: TerminalSlot) => void;
		onDragStart?: (index: number) => void;
		onDragMove?: (index: number, point: { x: number; y: number }) => void;
		onDragEnd?: (index: number, point: { x: number; y: number }) => void;
		onExit?: (slotId: string, code: number | null) => void;
		/**
		 * Put this pane's multiplexer into its own scroll mode, or take it back out.
		 *
		 * ⚠ THE PACKAGE CANNOT DO THIS ITSELF. Reaching a multiplexer's history means a
		 * command on the host, and `[TC-PDUI-030]` keeps fetches out of here — so the pane
		 * asks and the app answers, the same split the card's settings panel uses. Absent =
		 * no scroll control is drawn, which is right for a consumer with no such path.
		 */
		onScrollback?: (slot: TerminalSlot, action: "enter" | "exit") => void;
		/**
		 * Open this host's file explorer.
		 *
		 * ⚠ ABSENT = NO CONTROL, which here also carries a fact: the app passes it
		 * only when the host's agent announced it can browse. A button that could
		 * only ever answer "this agent is too old" is the scroll buttons' original
		 * bug, and this is the same rule.
		 */
		/**
		 * The pane's real history, when the consumer can fetch it. Returning null (or not
		 * passing this at all) falls back to the local buffer — see `openHistory`.
		 */
		onReadHistory?: (slot: TerminalSlot) => Promise<{ lines: HistoryLine[]; scrollback: boolean } | null>;
	}

	let {
		slot,
		index,
		hostName,
		adapter,
		createSurface = createXtermSurface,
		reachable = true,
		zoomed = false,
		focused = false,
		visible = true,
		stackAnchor = true,
		onScreen = true,
		keyBar = false,
		solo = false,
		order = 0,
		dragging = false,
		dropTarget = false,
		clickAction = 'zoom',
		t,
		onAssign,
		onZoom,
		onFocus,
		onClose,
		onDetach,
		onDragStart,
		onDragMove,
		onDragEnd,
		onExit,
		onScrollback,
		onReadHistory,
	}: Props = $props();

	const tr = $derived(translator(t));
	const label = $derived(slotLabel(slot, hostName));
	// A bare shell dies with its connection, so the label warns before you rely on it.
	const ephemeral = $derived(slot.kind === 'shell');
	/**
	 * The active pane: the one whose keystrokes go somewhere.
	 *
	 * Zoom counts because it already behaves that way — both states drop the click guard,
	 * so both take typing directly. It is one derived value so the guard and the focus
	 * ring can never disagree about which pane is live.
	 */
	const active = $derived(focused || zoomed);
	const guarded = $derived(!active);

	let surfaceHost = $state<HTMLDivElement | null>(null);
	let surface: TerminalSurface | null = null;
	let connection: TerminalConnection | null = null;

	$effect(() => {
		const host = surfaceHost;
		// Read the target synchronously so a retarget re-runs this effect.
		const target = { slotId: slot.id, hostId: slot.hostId, ...toProtocolTarget(slot) };
		if (!host) return;
		let disposed = false;
		const cleanups: Array<() => void> = [];

		void (async () => {
			let created: TerminalSurface;
			try {
				created = await createSurface(host);
			} catch {
				// A surface that cannot render (no canvas, no WebGL) must not take the
				// whole grid down with it — the rest of the panes keep working.
				return;
			}
			if (disposed) {
				created.dispose();
				return;
			}
			surface = created;
			const geometry = created.fit();
			const opened = await adapter.open({ ...target, cols: geometry.cols, rows: geometry.rows });
			if (disposed) {
				opened.close();
				return;
			}
			connection = opened;
			// Ask once now and then after every write: a pane that attaches to a multiplexer is
			// already in the alternate buffer before its first byte arrives.
			refreshScrollable();
			cleanups.push(
				opened.onData((data) => {
					created.write(data);
					// The write is what may have switched the buffer or the mouse mode.
					refreshScrollable();
				}),
			);
			cleanups.push(opened.onExit((code) => onExit?.(slot.id, code)));
			// Shift+wheel on a buffer with no local history. The surface decides that it
			// has nothing to scroll; what to do about it is this pane's business.
			cleanups.push(created.onScrollbackRequest(() => askScrollback()));
			// The Ctrl latch is spent HERE, on the surface -> connection bridge, because a
			// soft keyboard's characters do not arrive as `keydown` on iOS — they only reach
			// this callback. A latch that waited for a key event would never fire on a phone.
			cleanups.push(created.onData((data) => opened.send(spendCtrl(data))));
			if (typeof ResizeObserver !== 'undefined') {
				const observer = new ResizeObserver(() => {
					const next = created.fit();
					opened.resize(next.cols, next.rows);
				});
				observer.observe(host);
				cleanups.push(() => observer.disconnect());
			}
		})();

		return () => {
			disposed = true;
			for (const cleanup of cleanups) cleanup();
			connection?.close();
			surface?.dispose();
			connection = null;
			surface = null;
		};
	});

	// Coming back into view changes the box, so re-fit and tell the far end. `onScreen` is
	// the narrow-screen case (another tab was showing) and `visible` the pager's — both
	// leave the pane MOUNTED and only change its box, which is why a re-fit is all that is
	// needed. ⚠ `onScreen` must never reach the grid's hidden-pane bookkeeping: that drives
	// a ten-minute reaper, and an in-app tab switch is not the user walking away.
	$effect(() => {
		if (!visible || !onScreen) return;
		const next = surface?.fit();
		if (next) connection?.resize(next.cols, next.rows);
	});

	// --- soft keyboard helpers -------------------------------------------------
	/**
	 * Whether this pane carries the touch bars: the composer and the helper key row.
	 *
	 * `keyBar` is the DEVICE gate — the app passes `(pointer: coarse)` — so a desktop pane
	 * never grows these however visible it is. `visible && onScreen` is the same pair the
	 * re-fit effect above uses, i.e. "this pane's box is the one on the glass"; it also keeps
	 * exactly ONE composer in the document, because a pane that scrolled off the page stays
	 * mounted and would otherwise contribute a second hidden input field.
	 *
	 * ⚠ IT MUST NOT REQUIRE FOCUS. This read `keyBar && active && onScreen`, and on a phone
	 * nothing is focused until a finger lands — so the composer, which is the ONLY way to
	 * type Korean/Japanese/Chinese at a terminal here (`pdmux-work/docs/IME_INPUT.md`), was absent until
	 * the user tapped a pane they had no reason to believe was inert. Reported from an iPhone;
	 * Chrome's device emulation hid it because its pane came up focused.
	 *
	 * `solo` is what makes "no focus" safe rather than merely convenient: with one cell on
	 * screen the pane on screen IS the pane being used, so there is nothing for focus to
	 * disambiguate — and neither bar ever needed it, since both send on THIS pane's
	 * `connection` rather than to whatever holds the keyboard. In a split several panes are on
	 * screen at once, `active` is still the honest answer to "which terminal does this type
	 * into", and it stays as the other arm.
	 *
	 * REJECTED — focusing the on-screen pane instead of relaxing this test. It fights both
	 * mechanisms a phone depends on. (1) `focused` comes from the layout's `focusId`, which is
	 * PERSISTED AND SHARED with the user's other devices — the shell deliberately keeps a
	 * phone's cell cursor local for exactly this reason — so a phone that merely opened a pane
	 * would move the focus ring on their desktop. (2) `active` drops the click guard, and the
	 * guard's `pointerup` is the one place `surface.focus()` runs inside a user gesture, which
	 * is the only kind of focus a mobile browser answers by raising the software keyboard.
	 * Auto-focus would trade a missing composer for a missing keyboard, and take the
	 * drag-versus-tap classification (i.e. text selection) with it.
	 */
	const touchBar = $derived(keyBar && visible && onScreen && (active || solo));

	/** Ctrl, latched by the helper row: a finger cannot hold one key while pressing another. */
	let ctrlLatch = $state(false);

	function spendCtrl(data: string): string {
		if (!ctrlLatch) return data;
		ctrlLatch = false;
		return ctrlChord(data) ?? data;
	}

	/**
	 * A line composed in a real input field.
	 *
	 * The IME needs a normal text field to work in — a terminal's hidden textarea is not one,
	 * which is how Korean arrived as separate jamo on a phone. The finished line is sent as
	 * one write, with the carriage return the shell expects.
	 */
	function composerSubmit(text: string, submit: boolean): void {
		if (!text) return;
		connection?.send(submit ? `${text}\r` : text);
	}

	function helperKey(id: HelperKeyId): void {
		const press = pressHelperKey({ ctrl: ctrlLatch }, id);
		ctrlLatch = press.state.ctrl;
		if (press.data) connection?.send(press.data);
		// Focus goes straight back to the terminal, or the keyboard closes under the user.
		surface?.focus();
	}

	/**
	 * Whether the scroll buttons are worth drawing.
	 *
	 * ⚠ RE-READ AS OUTPUT ARRIVES — NEVER LATCHED. A pane enters and leaves the alternate
	 * buffer and turns mouse reporting on and off while it runs (`vim` opens, a multiplexer
	 * attaches, an agent's TUI starts), and every one of those changes the answer.
	 *
	 * THE BUG THIS COMMENT REPLACES: the only caller of `refreshScrollable` was `scrollPane`,
	 * i.e. the very press the value was supposed to gate. So on a multiplexer pane the buttons
	 * were drawn anyway (the seed is `true`), the tap did nothing, and the tap then latched
	 * them off for the life of the pane — leaving `vim` could not bring them back, because the
	 * only code that could set this true again was on the buttons that no longer existed.
	 * Reported from a phone as "the scroll buttons do not work, and they disappear the moment
	 * I press them", and reproduced exactly: present 1, frames sent 0, present 0.
	 *
	 * The data callback is where this belongs: a buffer switch and a mode change both ARRIVE
	 * as output. Assigning the same boolean is free, so a busy pane costs nothing.
	 */
	let canScroll = $state(true);

	function refreshScrollable(): void {
		canScroll = surface?.canScroll() ?? true;
	}

	function scrollPane(direction: -1 | 1): void {
		surface?.scrollPages(direction);
		refreshScrollable();
		// Same rule as every other control on this bar: the keyboard must not close.
		surface?.focus();
	}

	/**
	 * Scroll mode: the multiplexer's own history, asked for on the user's behalf.
	 *
	 * ⚠ THIS FLAG IS A HINT, NOT A MIRROR OF THE HOST. tmux is asked with `copy-mode -e`,
	 * which LEAVES on its own the moment the user scrolls back to the bottom — the usual
	 * way out, and one nothing here can observe. So the flag only drives a line of advice
	 * and a pressed-looking button; nothing depends on it being true, and pressing the
	 * control again sends `exit`, which is harmless on a pane that already left.
	 */
	let scrollMode = $state(false);

	/**
	 * ⚠ ONE GESTURE IS MANY EVENTS. A single flick of a wheel fires a dozen of them, and
	 * each would otherwise be a POST that runs a command on someone's machine. Entering
	 * the mode is idempotent, so the throttle costs nothing but the requests.
	 */
	const SCROLLBACK_ASK_MS = 700;
	let lastAsk = 0;

	function askScrollback(): void {
		if (!onScrollback) return;
		const now = Date.now();
		if (scrollMode && now - lastAsk < SCROLLBACK_ASK_MS) return;
		lastAsk = now;
		scrollMode = true;
		onScrollback(slot, 'enter');
	}

	function toggleScrollMode(): void {
		if (!onScrollback) return;
		lastAsk = Date.now();
		scrollMode = !scrollMode;
		onScrollback(slot, scrollMode ? 'enter' : 'exit');
		// The keyboard must not close, exactly as for the scroll buttons.
		surface?.focus();
	}

	/**
	 * The pane's output, as text, or null when the sheet is closed.
	 *
	 * ⚠ IT IS NOT ALWAYS A HISTORY, AND THE SHEET HAS TO SAY SO. A pane attached to a
	 * multiplexer runs it in xterm's ALTERNATE buffer, and xterm keeps no scrollback for
	 * that buffer at all — the history lives inside tmux, not here. So a session pane can
	 * only ever show its visible screen. Calling that "the full history" would be a lie the
	 * user cannot check, which is why `scrollback` travels with the lines.
	 *
	 * ⚠ UNLESS SOMEONE CAN GO AND GET IT. `onReadHistory` is the consumer offering to ask
	 * the multiplexer directly, which turns the notice above from a permanent limitation
	 * into a fallback. The local buffer is still the answer when that fetch is absent or
	 * fails, because a sheet that opens empty is worse than one that admits its scope.
	 */
	let history = $state<{ lines: HistoryLine[]; scrollback: boolean } | null>(null);
	let historyPending = $state(false);

	async function openHistory(): Promise<void> {
		const local = surface?.readHistory() ?? { lines: [], scrollback: false };
		// Paint what is already here first: the fetch is a round trip to another machine,
		// and an empty sheet that fills in later reads as a broken one.
		history = local;
		if (!onReadHistory || local.scrollback) return;
		historyPending = true;
		try {
			const remote = await onReadHistory(slot);
			// `history` going null means the user closed the sheet while we were away.
			if (remote && remote.lines.length > 0 && history !== null) history = remote;
		} catch {
			// Keep the visible screen and its notice — that is the honest fallback.
		} finally {
			historyPending = false;
		}
	}

	let down: PointerSample | null = null;

	/**
	 * ⚠ THE DRAG STATE BEGINS ON THE FIRST DRAGGING MOVE, NOT ON pointerdown.
	 *
	 * Announcing it on pointerdown meant a plain click entered it and never left: the
	 * release took the `click` branch (zoom) and only the `else` branch ended the drag,
	 * so `.pdmux-dragging`'s dim stayed over the terminal until something else re-rendered
	 * the pane. Users read that grey veil as a broken terminal — reported as exactly that.
	 * Every exit path below therefore ends what it started, including a cancelled gesture.
	 */
	function headerDown(event: PointerEvent): void {
		if ((event.target as HTMLElement).closest('button')) return;
		down = { x: event.clientX, y: event.clientY, t: event.timeStamp };
		const handle = event.currentTarget as HTMLElement;
		try {
			handle.setPointerCapture(event.pointerId);
		} catch {
			// Capture unsupported: the drag still works over plain areas.
		}
		let started = false;
		const move = (ev: PointerEvent): void => {
			if (!down) return;
			if (guardIntent(down, { x: ev.clientX, y: ev.clientY, t: ev.timeStamp }) !== 'drag') return;
			if (!started) {
				started = true;
				onDragStart?.(index);
			}
			onDragMove?.(index, { x: ev.clientX, y: ev.clientY });
		};
		const end = (ev: PointerEvent): void => {
			handle.removeEventListener('pointermove', move);
			handle.removeEventListener('pointerup', end);
			handle.removeEventListener('pointercancel', end);
			const start = down;
			down = null;
			if (!start) return;
			const point = { x: ev.clientX, y: ev.clientY, t: ev.timeStamp };
			const drop = { x: ev.clientX, y: ev.clientY };
			// A gesture that was never classified as a drag cannot end one; one that was
			// must end it whichever way it finishes (drop, plain release, or cancel).
			if (!started) {
				if (guardIntent(start, point) === 'click') onZoom?.(slot.id);
				return;
			}
			onDragEnd?.(index, drop);
		};
		handle.addEventListener('pointermove', move);
		handle.addEventListener('pointerup', end);
		handle.addEventListener('pointercancel', end);
	}

	let pressStart: PointerSample | null = null;

	/**
	 * Classify a press on the pane WITHOUT taking it away from the terminal.
	 *
	 * ⚠ THIS USED TO BE A TRANSPARENT BUTTON LAID OVER THE SURFACE, AND IT ATE EVERY
	 * SELECTION. `inset: 0`, no `pointer-events`, later in DOM order — so it won the hit
	 * test and xterm never received the press at all. Not cancelled: occluded. The old
	 * handler classified the gesture afterwards and, for a drag, merely focused the pane;
	 * its comment said "let the user drag again". The drag the user had just made was
	 * thrown away. `focusId` is a single slot for the whole layout and `null` on a fresh
	 * one, so that was EVERY pane. Reported as "drag does not copy".
	 *
	 * Listening on the pane body costs the terminal nothing: xterm registers no pointer
	 * listeners whatsoever, so these bubble up from `.xterm-screen` untouched while xterm
	 * keeps the compatibility mouse events it actually selects with.
	 *
	 * ⚠ NEVER `preventDefault()` HERE, and never capture the pointer. Cancelling suppresses
	 * the mouse events xterm needs; capturing RETARGETS them to this box mid-selection. The
	 * fix would undo itself either way.
	 */
	function paneDown(event: PointerEvent): void {
		// ⚠ ONLY WHILE GUARDED. An active pane's clicks belong to the program inside it —
		// positioning a cursor in vim, hitting a tmux status line. Classifying those would
		// mean every click in the pane you are working in toggles zoom, because
		// `clickAction` defaults to it.
		if (!guarded) return;
		pressStart = { x: event.clientX, y: event.clientY, t: event.timeStamp };
		// ⚠ RESOLVED ON THE WINDOW, not here. The release that matters most is the one that
		// happens OUTSIDE the pane — dragging past the edge is the ordinary way to select to
		// the end of a line — and the old handler never saw it: the press stayed on record
		// and the next click, measured against that stale timestamp, always came out a drag,
		// so click-to-zoom quietly stopped working. Pointer capture would fix the delivery
		// and break the selection, so the listeners go on the window instead.
		const settle = (up: PointerEvent): void => {
			window.removeEventListener('pointerup', settle);
			window.removeEventListener('pointercancel', cancel);
			paneUp(up);
		};
		const cancel = (): void => {
			window.removeEventListener('pointerup', settle);
			window.removeEventListener('pointercancel', cancel);
			pressStart = null;
		};
		window.addEventListener('pointerup', settle);
		window.addEventListener('pointercancel', cancel);
	}

	function paneUp(event: PointerEvent): void {
		const start = pressStart;
		pressStart = null;
		if (!start || !guarded) return;
		const intent = guardIntent(start, { x: event.clientX, y: event.clientY, t: event.timeStamp });
		// ⚠ UNCONDITIONALLY, FOR EVERY INTENT. `TerminalSurface.focus()` shipped once with
		// nothing calling it: focus fell to `<body>`, which reads as "I tapped the pane and
		// typing does nothing" and, on a phone, means the software keyboard never opens. A
		// browser only opens it for a programmatic focus inside a user gesture, so this
		// synchronous call is the one that counts.
		//
		// ⚠ AND IT MUST NOT BE LIMITED TO A CLICK. The drag threshold is 6px, which a finger
		// crosses on what its owner meant as a tap — and a touch drag produces no
		// compatibility mouse events, so xterm's own focus-on-mousedown never runs either.
		// Gating this on `click` silently reinstated the missing-keyboard bug.
		//
		// Focusing does not disturb a selection: xterm reports focus as `ESC [I` with
		// `wasUserInput` false, and only user input clears the selection.
		surface?.focus();
		if (intent === 'click' && clickAction === 'zoom') onZoom?.(slot.id);
		else onFocus?.(slot.id);
	}
</script>

<div
	class="pdmux pdmux-pane"
	class:pdmux-unreachable={!reachable}
	class:pdmux-dragging={dragging}
	class:pdmux-focused={active}
	class:pdmux-drop={dropTarget}
	data-pdmux-pane={slot.id}
	data-pdmux-cell={index}
	data-pdmux-stack={stackAnchor ? 'anchor' : 'rest'}
	data-pdmux-focused={active ? 'true' : 'false'}
	hidden={!visible}
	style="order:{order}"
>
	<div
		class="pdmux-pane-head"
		role="toolbar"
		tabindex="-1"
		aria-label={label}
		title={reachable
			? tr('pdmux.pane.headerHint', 'Click to zoom · drag to move')
			: tr('pdmux.pane.unreachable', 'This host is not reachable')}
		onpointerdown={headerDown}
	>
		<span class="pdmux-pane-label">
			#{index + 1}
			{label}{#if ephemeral}<span
					role="img"
					title={tr('pdmux.pane.ephemeral', 'Not persistent — ends with the connection')}
					aria-label={tr('pdmux.pane.ephemeral', 'Not persistent — ends with the connection')}
					>&nbsp;⚠</span
				>{/if}
		</span>
		<span class="pdmux-pane-acts">
			<button
				class="pdmux-ico"
				type="button"
				title={tr('pdmux.pane.retarget', 'Change target')}
				aria-label={tr('pdmux.pane.retarget', 'Change target')}
				data-pdmux-retarget
				onclick={(event) => onAssign?.(index, event.currentTarget as HTMLElement)}>▾</button
			>
			<!--
				Scroll mode: hand the wheel back to the multiplexer.

				⚠ NOT `⇞`/`⇟`. Those are the phone key row's page-scroll buttons, and a
				control that wears a familiar face while doing something else is worse than
				one nobody recognises. This turns a mode ON; it does not move by a page.

				⚠ AND IT IS NOT DRAWN WITHOUT SOMEWHERE TO SEND IT — a button that reports
				"scroll mode" and changes nothing is the scroll buttons' old bug again.
			-->
			{#if onScrollback}
				<button
					class="pdmux-ico"
					type="button"
					title={tr('pdmux.pane.scrollback', 'Scroll back through this session')}
					aria-label={tr('pdmux.pane.scrollback', 'Scroll back through this session')}
					aria-pressed={scrollMode}
					data-pdmux-scrollback
					onclick={toggleScrollMode}>⇕</button
				>
			{/if}
			<!--
				History. Reading the buffer is the only way to see output that has scrolled past
				a small pane, and on a phone there is no wheel to reach it with at all.
				⚠ It is NOT always a history — see `openHistory`.
			-->
			<button
				class="pdmux-ico"
				type="button"
				title={tr('pdmux.pane.history', 'Show output')}
				aria-label={tr('pdmux.pane.history', 'Show output')}
				data-pdmux-history
				onclick={() => void openHistory()}>☰</button
			>
			<button
				class="pdmux-ico"
				type="button"
				title={tr('pdmux.pane.zoom', 'Toggle zoom')}
				aria-label={tr('pdmux.pane.zoom', 'Toggle zoom')}
				onclick={() => onZoom?.(slot.id)}>{zoomed ? '⤡' : '⤢'}</button
			>
			<button
				class="pdmux-ico"
				type="button"
				title={tr('pdmux.pane.detach', 'Open in a new window')}
				aria-label={tr('pdmux.pane.detach', 'Open in a new window')}
				onclick={() => onDetach?.(slot)}>↗</button
			>
			<button
				class="pdmux-ico"
				type="button"
				title={tr('pdmux.pane.close', 'Close (this cell stays empty)')}
				aria-label={tr('pdmux.pane.close', 'Close (this cell stays empty)')}
				data-pdmux-close
				onclick={() => onClose?.(index)}>✕</button
			>
		</span>
	</div>
	<!--
		⚠ SAY WHAT JUST CHANGED, BECAUSE THE PANE LOOKS IDENTICAL. In the multiplexer's
		scroll mode the keys stop reaching the program — they drive the scroll instead —
		and nothing on screen would otherwise explain why typing does nothing. One line,
		naming the two ways out (the wheel, which leaves by itself at the bottom, and
		Escape), and it takes the place of no pane content: it is above the terminal, not
		over it.
	-->
	{#if scrollMode}
		<p class="pdmux-pane-hint" data-pdmux-scroll-hint>
			{tr('pdmux.pane.scrollbackHint', 'Scrolling this session — wheel to move, Esc to leave')}
		</p>
	{/if}
	<!-- The pane body classifies the press; see `paneDown`. It listens rather than covers,
	     so a drag reaches the terminal and can be selected.

	     svelte-ignore: this box is NOT a control and must not become one. It observes a
	     gesture that belongs to the terminal inside it — giving it a role would announce a
	     button that does not exist and put a second tab stop in front of the pane. The
	     accessible affordance is the `.pdmux-guard` button below, which keeps its own name
	     and its own keyboard activation. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="pdmux-pane-body"
		data-message={tr('pdmux.pane.unreachable', 'This host is not reachable')}
		onpointerdown={paneDown}
	>
		{#if guarded}
			<!--
				KEYBOARD ONLY, and that is its whole remaining job. The stylesheet gives it
				`pointer-events: none`, so it no longer hit-tests and no longer occludes the
				terminal — but it is still the only way to reach "focus this pane" with a
				Tab and an Enter, and a keyboard activation fires `click` regardless of
				`pointer-events`. Deleting it would have been an accessibility regression
				traded for a bug fix that did not need it.
			-->
			<button
				class="pdmux-guard"
				type="button"
				aria-label={tr('pdmux.pane.focus', 'Focus this pane')}
				data-pdmux-guard
				onclick={() => {
					surface?.focus();
					onFocus?.(slot.id);
				}}
			></button>
		{/if}
		<div class="pdmux-pane-surface" bind:this={surfaceHost} data-pdmux-surface></div>
	</div>
	<!-- Under the terminal, above the keyboard: the keys a phone does not have. On the pane the
	     user is LOOKING at, which is not the same thing as the pane that happens to hold
	     focus — see `touchBar` for why that distinction is the whole bug. -->
	{#if touchBar}
		<!-- The composer is above the key row because that is the order they are used in:
		     compose a line, then reach for a control key. Both only exist on a touch screen. -->
		<TerminalComposer {t} onSubmit={composerSubmit} />
		<!-- ⚠ NO POPOVER. `⌘` on this row turns it to the next set of keys IN PLACE; the
		     panel that used to open here was a thing on top of the terminal it types into,
		     which is exactly what was reported. See `TerminalKeyBar`. -->
		<TerminalKeyBar ctrl={ctrlLatch} scrollable={canScroll} {t} onKey={helperKey} onScroll={scrollPane} />
	{/if}

	{#if history}
		<TerminalHistory
			lines={history.lines}
			scrollback={history.scrollback}
			title={label}
			{t}
			onClose={() => (history = null)}
			onCopy={(text) => void writeClipboard(text)}
		/>
	{/if}
</div>
