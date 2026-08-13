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

/**
 * What a card says about its agent, if anything.
 *
 * ⚠ A SHAPE AND A NAME, NEVER A VERSION STRING OR A PHASE ENUM. The package has no
 * interpolation (`Translate` takes a key and a fallback, nothing else) and no
 * business knowing what semver is; the app composes the sentence, the card draws it.
 * That is the same seam `CardSettingsPopover.status` already uses.
 */
export type HostUpdateKind = 'offer' | 'urgent' | 'busy';

export interface HostUpdateMark {
	kind: HostUpdateKind;
	/** The whole line, already translated and interpolated. Never colour alone. */
	label: string;
}

export interface HostSummary {
	id: string;
	name: string;
	state?: HostState;
	/** Absent means the card draws nothing — it is not a row that renders empty. */
	update?: HostUpdateMark | null;
}

export interface HostResources {
	cpuPct?: number | null;
	memPct?: number | null;
	diskPct?: number | null;
	swapPct?: number | null;
	/** Absolute detail for a tooltip, e.g. "12Gi/30Gi" — a percentage cannot say it. */
	memHint?: string;
	diskHint?: string;
	/**
	 * ⚠ THE ONLY THING THAT SEPARATES "NO SWAP" FROM "SWAP IS EMPTY". Both report
	 * 0%, and they are different facts about the machine: "0B/0B" has nowhere to
	 * swap to, "0B/8Gi" has somewhere and has not needed it.
	 */
	swapHint?: string;
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

/**
 * One entry of a host directory, as the explorer draws it.
 *
 * Declared here rather than imported from the contract for the reason the rest
 * of this file exists: this package takes data as props and must not depend on
 * the agent protocol to be installable.
 */
export interface FsEntryView {
	name: string;
	dir: boolean;
	/** Marked because such a link may refuse to open — see `FileExplorer`. */
	symlink: boolean;
	size: number;
	modified: number;
}

/** How a click on a listing row asked for the selection to change. */
export type SelectMode = 'single' | 'toggle' | 'range';

/**
 * One file read from a host's disk — the shape `BlobView` already renders.
 *
 * The app declares the same shape for its API layer; this copy exists so the
 * package's own props are typed without importing from an app, which
 * `[TC-PDUI-030]` forbids.
 */
export interface FsFileView {
	path: string;
	lines: string[];
	binary: boolean;
	truncated: boolean;
	bytes: number;
	error: string | null;
}

export interface FsDirView {
	path: string;
	/**
	 * The absolute home this listing is relative to, for display only. Empty when
	 * the agent is too old to say — the path bar then writes `~`.
	 */
	home?: string;
	entries: readonly FsEntryView[];
	/** Entries the host left out, so the panel can say how many. */
	dropped: number;
	truncated: boolean;
	/** A refusal is shown as it is — a permission error is the OS answering. */
	error: string | null;
}
