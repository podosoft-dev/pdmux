import { DEFAULT_TERMINAL_PREFERENCES, parseTerminalPreferences, type TerminalPreferences } from "@pdmux/core";
import { createXtermSurface, type TerminalSurfaceFactory } from "@pdmux/ui";
import { desktopPreferences } from "#lib/desktop.js";

let current = $state<TerminalPreferences>({ ...DEFAULT_TERMINAL_PREFERENCES });
let load: Promise<void> | undefined;
const listeners = new Set<(value: TerminalPreferences) => void>();

export const terminalPreferences = {
  get value(): TerminalPreferences { return current; },
  async load(): Promise<void> {
    const bridge = desktopPreferences();
    if (!bridge) return;
    load ??= bridge.read().then(value => { current = parseTerminalPreferences(value); for (const listener of listeners) listener(current); }).catch(error => { load = undefined; throw error; });
    await load;
  },
  async save(value: TerminalPreferences): Promise<void> {
    const bridge = desktopPreferences();
    if (!bridge) throw new Error("Desktop preferences are unavailable");
    current = parseTerminalPreferences(await bridge.save(parseTerminalPreferences(value)));
    for (const listener of listeners) listener(current);
  },
};

export const desktopTerminalSurface: TerminalSurfaceFactory = async host => {
  const surface = await createXtermSurface(host);
  if (!desktopPreferences()) return surface;
  // Load before the first upstream geometry is sent, avoiding a second session open.
  try { await terminalPreferences.load(); } catch { /* Existing terminals remain usable; settings reports the read error. */ }
  const resized = new Set<() => void>();
  const apply = (preferences: TerminalPreferences): void => {
    surface.setAppearance?.(preferences);
    for (const listener of resized) listener();
  };
  apply(terminalPreferences.value);
  listeners.add(apply);
  return { ...surface, onAppearanceChange: listener => { resized.add(listener); return () => resized.delete(listener); }, dispose: (): void => { listeners.delete(apply); resized.clear(); surface.dispose(); } };
};
