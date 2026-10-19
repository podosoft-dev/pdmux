import { DEFAULT_TERMINAL_PREFERENCES, parseTerminalPreferences, type TerminalPreferences } from "@pdmux/core";
import { createXtermSurface, type TerminalSurfaceFactory } from "@pdmux/ui";
import { desktopPreferences } from "#lib/desktop.js";
import { page } from "$app/state";

let current = $state<TerminalPreferences>({ ...DEFAULT_TERMINAL_PREFERENCES });
let load: Promise<void> | undefined;
let account = "anonymous";
const storageKey = () => `pdmux:terminal-preferences:${account}`;
const listeners = new Set<(value: TerminalPreferences) => void>();
let stopStorageWatch: (() => void) | undefined;

export const terminalPreferences = {
  setAccount(id: string): void { if (account !== id) { account = id; load = undefined; current = { ...DEFAULT_TERMINAL_PREFERENCES }; } },
  get value(): TerminalPreferences { return current; },
  async load(): Promise<void> {
    const userId = page.data.user?.id;
    if (userId) terminalPreferences.setAccount(userId);
    const bridge = desktopPreferences();
    if (!bridge) {
      if (typeof localStorage !== "undefined") {
        try { const saved = localStorage.getItem(storageKey()); current = saved ? parseTerminalPreferences(JSON.parse(saved)) : { ...DEFAULT_TERMINAL_PREFERENCES }; } catch { current = { ...DEFAULT_TERMINAL_PREFERENCES }; }
        for (const listener of listeners) listener(current);
      }
      return;
    }
    load ??= bridge.read().then(value => { current = parseTerminalPreferences(value); for (const listener of listeners) listener(current); }).catch(error => { load = undefined; throw error; });
    await load;
  },
  async save(value: TerminalPreferences): Promise<void> {
    const bridge = desktopPreferences();
    const parsed = parseTerminalPreferences(value);
    if (bridge) current = parseTerminalPreferences(await bridge.save(parsed));
    else { localStorage.setItem(storageKey(), JSON.stringify(parsed)); current = parsed; }
    for (const listener of listeners) listener(current);
  },
};

export const desktopTerminalSurface: TerminalSurfaceFactory = async host => {
  const surface = await createXtermSurface(host);
  // Load before the first upstream geometry is sent, avoiding a second session open.
  try { await terminalPreferences.load(); } catch { /* Existing terminals remain usable; settings reports the read error. */ }
  const resized = new Set<() => void>();
  const apply = (preferences: TerminalPreferences): void => {
    surface.setAppearance?.(preferences);
    for (const listener of resized) listener();
  };
  apply(terminalPreferences.value);
  listeners.add(apply);
  if (!desktopPreferences() && !stopStorageWatch) {
    const changed = (event: StorageEvent): void => { if (event.key === storageKey()) void terminalPreferences.load(); };
    window.addEventListener("storage", changed);
    stopStorageWatch = () => window.removeEventListener("storage", changed);
  }
  return { ...surface, onAppearanceChange: listener => { resized.add(listener); return () => resized.delete(listener); }, dispose: (): void => {
    listeners.delete(apply); resized.clear(); surface.dispose();
    if (listeners.size === 0) { stopStorageWatch?.(); stopStorageWatch = undefined; }
  } };
};
