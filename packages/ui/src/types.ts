/**
 * Prop shapes shared by more than one component.
 *
 * They live in a `.ts` file rather than inside a component because Svelte's runes
 * mode does not allow `export` from an instance script, and because a consumer
 * writing its own wrapper needs to name these types.
 */
import type { GridSession } from '@pdmux/core';

/** Reachability as a card shows it. `unknown` is deliberately distinct from offline. */
export type HostState = 'online' | 'offline' | 'unknown';

export interface HostSummary {
	id: string;
	name: string;
	state?: HostState;
}

export interface HostResources {
	cpuPct?: number | null;
	memPct?: number | null;
	diskPct?: number | null;
	/** Absolute detail for a tooltip, e.g. "12Gi/30Gi" — a percentage cannot say it. */
	memHint?: string;
	diskHint?: string;
}

/** A key/value line in the card settings popover (address, ssh command, …). */
export interface HostDetail {
	key: string;
	label: string;
	value: string;
}

/** A host as the terminal target picker needs it. */
export interface PickerHost {
	id: string;
	name: string;
	online: boolean;
	sessions?: readonly GridSession[];
	/**
	 * Whether this host has a terminal multiplexer at all.
	 *
	 * Optional and **defaulting to true** on purpose: every other producer of this
	 * shape predates the field, and a host that simply has not reported yet must
	 * not have its session targets taken away on a guess. Only a host that has
	 * positively said it has none gets `false`.
	 */
	multiplexer?: boolean;
}

/**
 * What the picker hands back. `attach` and `new` are the same wire target — the
 * distinction is the user's intent, which the layout keeps so the label can say it.
 */
export interface PickerTarget {
	hostId: string;
	kind: 'attach' | 'new' | 'shell';
	session?: string | null;
}

/**
 * Where a repository's HEAD is, as the refs panel states it.
 *
 * `upstream`/`ahead`/`behind`/`gone` describe the tracking branch of HEAD, which the
 * caller resolves — the panel does not guess which ref HEAD follows.
 */
export interface RepoHead {
	branch?: string | null;
	sha?: string | null;
	detached?: boolean;
	upstream?: string | null;
	ahead?: number | null;
	behind?: number | null;
	/** The upstream this branch tracked no longer exists on the remote. */
	gone?: boolean;
	/** Absolute path on the host; the panel shows it as the repository's identity. */
	path?: string | null;
}
