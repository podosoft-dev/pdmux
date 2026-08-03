/**
 * SemVer — only as much of it as this protocol needs, in a form the Go agent can
 * reproduce exactly.
 *
 * WHY IT LIVES IN THE CONTRACT PACKAGE: three programs must agree on whether a host
 * is "outdated". The API decides it, the browser renders it, and the agent refuses a
 * downgrade using the same rule. A comparator that disagrees between them shows an
 * Update button the agent then rejects — which reads as a broken product rather than
 * as the disagreement it is.
 *
 * WHY NOT A LIBRARY: the Go agent must behave *identically*, and matching another
 * project's edge-case choices across two ecosystems is harder than owning eighty
 * lines. `conformance/semver.json` is the proof — both languages read the same table.
 *
 * WHAT IS DELIBERATELY MISSING: ranges, carets, tildes, coercion. Nothing here needs
 * "^1.2" — it needs "is this one older than that one", and every extra feature is
 * another thing two implementations can disagree about.
 */

/**
 * The lowest agent version this server understands well enough to keep features on.
 *
 * ⚠ THE `-0` IS LOAD-BEARING, NOT A TYPO. A prerelease sorts *below* the release it
 * leads to, so a floor of plain `0.1.0` puts every working-tree build —
 * `0.1.0-dev.3+g1a2b3c`, which is exactly what an agent compiled from a checkout
 * reports — below the floor, and every developer's own machine wears a red
 * `incompatible` badge while 0.1.0 is being written. `0.1.0-0` is the lowest possible
 * prerelease of 0.1.0, so it admits every build of that version and still excludes
 * anything genuinely older.
 *
 * Raise this only when the server truly stops understanding an older agent. It is a
 * badge and a warning — never a reason to refuse a connection, because the one thing
 * you must always be able to do to a too-old agent is tell it to update.
 */
export const MIN_SUPPORTED_AGENT = '0.1.0-0';

export interface Semver {
	major: number;
	minor: number;
	patch: number;
	/** Dot-separated identifiers. Empty for a release. `1.0.0-rc.1` → `['rc','1']`. */
	prerelease: string[];
	/** Carried so a caller can display it; NEVER part of an ordering (SemVer §10). */
	build: string[];
}

/** No leading zeros — `01` is not a SemVer number, and accepting it invites two readings. */
const NUMERIC = /^(0|[1-9]\d*)$/;
const DIGITS = /^\d+$/;
const IDENTIFIER = /^[0-9A-Za-z-]+$/;

/**
 * Parse, or return null. Never throws: the input is a string an agent sent us, and a
 * host with a weird version string must still appear in the UI — that is exactly the
 * host somebody needs to update.
 */
export function parseSemver(value: string | null | undefined): Semver | null {
	if (typeof value !== 'string' || value.length === 0 || value.length > 256) return null;

	// Build metadata comes off FIRST: in `1.0.0-rc.1+g1a2b3c` the `+` sits after the
	// `-`, so stripping in the other order would swallow the build into the prerelease.
	let rest = value;
	let build: string[] = [];
	const plus = rest.indexOf('+');
	if (plus >= 0) {
		build = rest.slice(plus + 1).split('.');
		rest = rest.slice(0, plus);
		if (!build.every((id) => IDENTIFIER.test(id))) return null;
	}

	let prerelease: string[] = [];
	const dash = rest.indexOf('-');
	if (dash >= 0) {
		prerelease = rest.slice(dash + 1).split('.');
		rest = rest.slice(0, dash);
		if (!prerelease.every((id) => IDENTIFIER.test(id))) return null;
		// A numeric identifier keeps the no-leading-zeros rule; an alphanumeric one does
		// not (`0a` is a fine identifier).
		if (prerelease.some((id) => DIGITS.test(id) && !NUMERIC.test(id))) return null;
	}

	const core = rest.split('.');
	if (core.length !== 3 || !core.every((part) => NUMERIC.test(part))) return null;
	const [major, minor, patch] = core.map((part) => Number(part)) as [number, number, number];
	return { major, minor, patch, prerelease, build };
}

/** ASCII order. Both `<` on a JS string and Go's byte compare agree over `[0-9A-Za-z-]`. */
function compareIdentifiers(a: string, b: string): number {
	const aNum = NUMERIC.test(a);
	const bNum = NUMERIC.test(b);
	// "Numeric identifiers always have lower precedence than alphanumeric" (SemVer §11).
	if (aNum && !bNum) return -1;
	if (!aNum && bNum) return 1;
	if (aNum && bNum) {
		const left = Number(a);
		const right = Number(b);
		return left === right ? 0 : left < right ? -1 : 1;
	}
	return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * -1 / 0 / 1. Build metadata is ignored, so `1.0.0+a` and `1.0.0+b` are the SAME
 * version — which is why the update path pins a sha256 as well as a version.
 */
export function compareSemver(a: Semver, b: Semver): -1 | 0 | 1 {
	for (const [left, right] of [
		[a.major, b.major],
		[a.minor, b.minor],
		[a.patch, b.patch],
	] as const) {
		if (left !== right) return left < right ? -1 : 1;
	}

	// A prerelease is LOWER than the release it leads to: 1.0.0-rc.1 < 1.0.0.
	const aPre = a.prerelease.length > 0;
	const bPre = b.prerelease.length > 0;
	if (aPre !== bPre) return aPre ? -1 : 1;
	if (!aPre) return 0;

	const shared = Math.min(a.prerelease.length, b.prerelease.length);
	for (let i = 0; i < shared; i += 1) {
		const verdict = compareIdentifiers(a.prerelease[i] as string, b.prerelease[i] as string);
		if (verdict !== 0) return verdict < 0 ? -1 : 1;
	}
	// All shared identifiers equal — more identifiers wins (`1.0.0-a` < `1.0.0-a.1`).
	if (a.prerelease.length === b.prerelease.length) return 0;
	return a.prerelease.length < b.prerelease.length ? -1 : 1;
}

/** Convenience for callers holding strings; unparseable input sorts as `null`. */
export function compareVersionStrings(a: string, b: string): -1 | 0 | 1 | null {
	const left = parseSemver(a);
	const right = parseSemver(b);
	if (!left || !right) return null;
	return compareSemver(left, right);
}

/**
 * How a host's agent version reads on a card.
 *
 * `incompatible` is a HARD statement (the wire contract differs, or the build predates
 * what this server supports); everything else is advisory. Note what is NOT here: a
 * state that refuses the connection. The one thing you must always be able to do to a
 * too-old agent is tell it to update, and you cannot tell it anything if you hung up.
 */
export type AgentVersionState = 'current' | 'outdated' | 'ahead' | 'unknown' | 'incompatible';

export interface AgentVersionInput {
	/** What the agent reported in `hello`. Free-form on the wire, on purpose. */
	agentVersion: string | null;
	/** `hello.protocolVersion`, or null when the host has never connected. */
	protocolVersion: number | null;
	/** Newest published build FOR THAT HOST's os/arch, or null when none is published. */
	latest: string | null;
	/** `PROTOCOL_VERSION` — passed in so this file stays free of frame imports. */
	protocolVersionSupported: number;
}

export function agentVersionState(input: AgentVersionInput): AgentVersionState {
	const current = parseSemver(input.agentVersion);

	if (input.protocolVersion !== null && input.protocolVersion !== input.protocolVersionSupported) {
		return 'incompatible';
	}
	const floor = parseSemver(MIN_SUPPORTED_AGENT);
	if (current && floor && compareSemver(current, floor) < 0) return 'incompatible';

	// Two different unknowns share one state on purpose: the agent's version is
	// unreadable, OR nothing is published for its platform. Both mean "we cannot say
	// this host is behind", and inventing a second badge for that would say nothing a
	// reader could act on differently.
	if (!current) return 'unknown';
	const latest = parseSemver(input.latest);
	if (!latest) return 'unknown';

	const verdict = compareSemver(current, latest);
	if (verdict > 0) return 'ahead';
	if (verdict < 0) return 'outdated';
	return 'current';
}
