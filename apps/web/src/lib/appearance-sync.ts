/**
 * How this browser and the user's shared appearance record agree on theme and language.
 *
 * ⚠ ONE RECORD IS SHARED BY EVERY DEVICE THE USER SIGNS IN ON, AND EVERY TAB USED TO WRITE IT.
 * A page wrote its own theme and language back whenever they differed from what it last saw —
 * including when nobody had chosen anything, such as a page the server rendered in English
 * because it could not read the site settings. Every other device polls the record and adopts
 * it, so one such page switched the user's Korean screens to English a few seconds later.
 *
 * The rules that stop it:
 * - The first read adopts the record, as before: a new tab follows the user's last choice.
 * - After that, a field is adopted only when the record's value CHANGED since this page last
 *   saw it. A record that merely disagrees with this page is not a new choice.
 * - This page writes only when someone changed a field HERE after the page settled, and it
 *   writes that field alone — the other one keeps the record's value, so a theme toggle on a
 *   device showing English does not also publish English.
 */
export type Theme = "light" | "dark" | "system";
export interface Appearance {
  theme: Theme;
  locale: string;
}

const THEMES: readonly string[] = ["light", "dark", "system"];

export function parseAppearance(value: unknown, locales: readonly string[]): Appearance | null {
  if (typeof value !== "object" || value === null) return null;
  const { theme, locale } = value as { theme?: unknown; locale?: unknown };
  if (typeof theme !== "string" || !THEMES.includes(theme)) return null;
  if (typeof locale !== "string" || !locales.includes(locale)) return null;
  return { theme: theme as Theme, locale };
}

/**
 * What to change on this page after reading the record. `seen` is the record as this page last
 * saw or wrote it; null before the first read, when the record is adopted outright.
 */
export function remoteChanges(remote: Appearance, current: Appearance, seen: Appearance | null): Partial<Appearance> {
  const changes: Partial<Appearance> = {};
  if ((seen === null || remote.theme !== seen.theme) && remote.theme !== current.theme) changes.theme = remote.theme;
  if ((seen === null || remote.locale !== seen.locale) && remote.locale !== current.locale) changes.locale = remote.locale;
  return changes;
}

/**
 * The record to write after a change made on this page, or null when nothing changed here.
 * `baseline` is what the page showed once it last settled (its first read, or an adoption).
 */
export function localWrite(current: Appearance, baseline: Appearance, seen: Appearance | null): Appearance | null {
  const theme = current.theme !== baseline.theme;
  const locale = current.locale !== baseline.locale;
  if (!theme && !locale) return null;
  return {
    theme: theme ? current.theme : (seen?.theme ?? current.theme),
    locale: locale ? current.locale : (seen?.locale ?? current.locale),
  };
}

/** The page's side of the agreement — what the component keeps between polls. */
export class AppearanceAgreement {
  /** The record as this page last saw or wrote it. */
  seen: Appearance | null = null;
  /** What this page showed when it last settled; a difference from it is a choice made here. */
  baseline: Appearance | null = null;

  reset(): void {
    this.seen = null;
    this.baseline = null;
  }

  /** A record was read (null: none stored yet). Returns what this page should adopt. */
  read(remote: Appearance | null, current: Appearance): Partial<Appearance> {
    if (!remote) {
      this.baseline ??= { ...current };
      return {};
    }
    const changes = remoteChanges(remote, current, this.seen);
    this.seen = remote;
    // Only the adopted fields settle: a choice made here and not yet written stays pending.
    this.baseline = { ...(this.baseline ?? current), ...changes };
    return changes;
  }

  /** The record to write for a choice made here, or null. */
  pending(current: Appearance): Appearance | null {
    return this.baseline ? localWrite(current, this.baseline, this.seen) : null;
  }

  /** A write was sent for `current`; `stored` is set once the server accepted it. */
  wrote(current: Appearance, stored: Appearance | null): void {
    this.baseline = { ...current };
    if (stored) this.seen = stored;
  }
}
