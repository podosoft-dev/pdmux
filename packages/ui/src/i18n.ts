/**
 * Translation seam.
 *
 * WHY A PROP AND NOT A STORE: this package is installed by applications that already
 * own an i18n runtime. A store (or a bundled message catalogue) would force them to
 * adopt ours, so every component takes an optional `t` and falls back to the English
 * text passed at the call site — a consumer that does nothing still gets readable
 * output, and a consumer with translations keeps full control.
 */
export type Translate = (key: string, fallback: string) => string;

/** Default translator: return the call site's fallback verbatim. */
export const identityTranslate: Translate = (_key, fallback) => fallback;

/** Resolve an optional translator without branching at every call site. */
export function translator(t: Translate | undefined): Translate {
	return typeof t === 'function' ? t : identityTranslate;
}
