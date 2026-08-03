/**
 * Where the user's screen is kept.
 *
 * THE RULE (ARCHITECTURE §6): the server is the source of truth, localStorage is a
 * first-paint cache. The previous generation of this tool stored layouts in the
 * browser only, so there was no such thing as "my screen" — a new laptop meant a
 * blank dashboard and there was nowhere to hang a per-user default.
 *
 * Saving is debounced and de-duplicated because the things that change a layout are
 * gestures: a splitter drag emits a layout per pointer move, and writing each one
 * would put a hundred requests on the wire for one drag.
 */
import type { CardPrefsMap, TerminalLayout } from "@pdmux/core";
import { sanitizeCardPrefs } from "@pdmux/core";
import type { PrefsView } from "./types";

/** Server-side layout name. One default layout per user for now; the API stores many. */
export const LAYOUT_NAME = "default";
/** Bumped when the cached shape changes, so an old cache is ignored, not repaired. */
export const LAYOUT_CACHE_KEY = "pdmux.layout.v1";

/** The minimal storage surface — a test passes a Map-backed fake. */
export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The layout a page should paint before the server answers.
 *
 * Anything unreadable returns null instead of throwing: a corrupt cache must cost a
 * default screen, never the page.
 */
export function readCachedLayout(storage: LayoutStorage | null | undefined): unknown {
  if (!storage) return null;
  try {
    const raw = storage.getItem(LAYOUT_CACHE_KEY);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

export function writeCachedLayout(storage: LayoutStorage | null | undefined, layout: TerminalLayout): void {
  if (!storage) return;
  try {
    storage.setItem(LAYOUT_CACHE_KEY, JSON.stringify(layout));
  } catch {
    // A full or blocked storage costs the cache, not the session.
  }
}

/** The stored layout for this user: the default one, else the one we write. */
export function pickLayoutPayload(prefs: PrefsView | null | undefined): unknown {
  const layouts = prefs?.layouts ?? [];
  const preferred = layouts.find((entry) => entry.isDefault) ?? layouts.find((entry) => entry.name === LAYOUT_NAME);
  return preferred?.payload ?? null;
}

/**
 * Fold the per-host widget rows into the layout's card map.
 *
 * Two sources, one screen: the layout carries `cards` so a whole layout is one
 * document, while `/prefs/hosts/:id` is the row a single ⚙ toggle writes. The row
 * wins — it is the newest thing the user touched.
 */
export function mergeHostPrefs(cards: CardPrefsMap, hostPrefs: Record<string, Record<string, unknown>> | undefined): CardPrefsMap {
  const merged: CardPrefsMap = { ...sanitizeCardPrefs(cards) };
  for (const [hostId, widgets] of Object.entries(hostPrefs ?? {})) {
    const clean = sanitizeCardPrefs({ [hostId]: widgets })[hostId];
    if (clean) merged[hostId] = { ...merged[hostId], ...clean };
  }
  return merged;
}

export interface LayoutSaverOptions {
  save: (layout: TerminalLayout) => Promise<unknown>;
  delayMs?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  onError?: (cause: unknown) => void;
}

export interface LayoutSaver {
  queue(layout: TerminalLayout): void;
  /** Write anything pending right now (page unload, explicit save). */
  flush(): void;
  dispose(): void;
}

/**
 * Debounced, coalescing layout writer.
 *
 * It also drops a save whose serialised payload equals the last one written: paging
 * back and forth returns the layout to a state the server already has, and a write
 * for that is pure noise in the audit trail.
 */
export function createLayoutSaver(options: LayoutSaverOptions): LayoutSaver {
  const delay = options.delayMs ?? 700;
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let handle: unknown = null;
  let pending: TerminalLayout | null = null;
  let lastWritten = "";
  let disposed = false;

  const write = (): void => {
    handle = null;
    const layout = pending;
    pending = null;
    if (!layout || disposed) return;
    const serialised = JSON.stringify(layout);
    if (serialised === lastWritten) return;
    lastWritten = serialised;
    void options.save(layout).catch((cause: unknown) => {
      // A failed write must not poison the de-duplication, or the next identical
      // layout would be skipped and the server would stay behind for good.
      lastWritten = "";
      options.onError?.(cause);
    });
  };

  return {
    queue(layout: TerminalLayout): void {
      if (disposed) return;
      pending = layout;
      if (handle !== null) cancel(handle);
      handle = schedule(write, delay);
    },
    flush(): void {
      if (handle !== null) cancel(handle);
      write();
    },
    dispose(): void {
      if (handle !== null) cancel(handle);
      handle = null;
      pending = null;
      disposed = true;
    },
  };
}
