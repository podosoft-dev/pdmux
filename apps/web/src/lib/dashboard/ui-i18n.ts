/**
 * The bridge between this app's message catalogue and `@pdmux/ui`.
 *
 * The package asks for `t(key, fallback)` and owns no catalogue of its own, exactly
 * so the consuming app stays in charge of wording and locales. Its keys are dotted
 * (`pdmux.pane.zoom`); ours are a nested object, so this walks the tree and falls
 * back to the call site's English when a key is missing — a half-translated locale
 * degrades to readable text rather than to a key name on screen.
 */
import type { Translate } from "@pdmux/ui";

function lookup(source: unknown, key: string): unknown {
  let current = source;
  for (const part of key.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function uiTranslate(messages: unknown): Translate {
  return (key: string, fallback: string): string => {
    const value = lookup(messages, key);
    return typeof value === "string" && value.length > 0 ? value : fallback;
  };
}
