/**
 * Service launcher: every URL a host exposes, in one list.
 *
 * WHY DERIVED, NEVER COPIED: hard-coding a few links meant most exposed services had
 * to be typed by hand, and any service added elsewhere was invisible here. The list
 * is built from the registered services plus their probe results, so adding one
 * upstream is enough.
 */

export type ServiceStatus = 'up' | 'down' | 'unknown';

export interface ServiceInput {
	id: string;
	label: string;
	url: string;
	status?: ServiceStatus | null;
}

export interface ServiceOption {
	id: string;
	label: string;
	url: string;
	status: ServiceStatus;
	/** Label with its liveness glyph, ready for a plain `<option>`. */
	text: string;
}

/** Liveness glyph. An unprobed port gets none — silence is not "down". */
const GLYPH: Record<ServiceStatus, string> = { up: '● ', down: '○ ', unknown: '' };

/**
 * The label without its liveness glyph.
 *
 * A refresh that re-derives option text FROM the text on screen must strip first,
 * or glyphs stack up ("● ● admin") one refresh at a time.
 */
export function serviceLabel(text: unknown): string {
	return String(text ?? '').replace(/^[●○]\s*/, '');
}

/** Option text for a service: glyph by status + the bare label. */
export function serviceOptionText(text: unknown, status?: ServiceStatus | null): string {
	return `${GLYPH[status ?? 'unknown'] ?? ''}${serviceLabel(text)}`;
}

/** Build the option list in the order the services were registered. */
export function serviceOptions(services: readonly ServiceInput[]): ServiceOption[] {
	return (Array.isArray(services) ? services : [])
		.filter((s): s is ServiceInput => Boolean(s) && typeof s.url === 'string')
		.map((s) => {
			const status: ServiceStatus = s.status === 'up' || s.status === 'down' ? s.status : 'unknown';
			const label = serviceLabel(s.label);
			return { id: String(s.id ?? label), label, url: s.url, status, text: serviceOptionText(label, status) };
		});
}

/**
 * Which service should be selected when a card first renders: the first one that is
 * up, else the first at all — so pressing "open" immediately hits something alive.
 */
export function defaultServiceSelection(options: readonly ServiceOption[]): string | null {
	if (!options.length) return null;
	return (options.find((o) => o.status === 'up') ?? options[0])?.url ?? null;
}

/**
 * The URL an "open" press should use, or null when there is nothing to open.
 *
 * Takes anything shaped like a select (`{disabled, value}`) so the rule is testable
 * without a DOM. A disabled select means the host is not reachable, i.e. every one
 * of its URLs is dead. Anything that is not http(s) is refused rather than handed to
 * `window.open` — the values are generated, but this is the last gate.
 */
export function openTarget(select: { disabled?: boolean; value?: unknown } | null | undefined): string | null {
	if (!select || select.disabled) return null;
	const url = String(select.value ?? '');
	return /^https?:\/\//.test(url) ? url : null;
}
