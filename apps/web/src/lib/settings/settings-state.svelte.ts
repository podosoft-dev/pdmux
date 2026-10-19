import { getContext, setContext } from "svelte";
import { SvelteMap } from "svelte/reactivity";

export type SettingsTab = "general" | "terminal" | "hosts" | "fleet" | "access" | "connection" | "advanced";
export interface SettingsDraft {
  readonly dirty: boolean;
  readonly valid: boolean;
  readonly busy: boolean;
  save(): Promise<boolean>;
  reset(): void;
}
const KEY = Symbol("settings-dialog");

export function provideSettings(lifecycle: { onOpen?: () => void; onClose?: () => void } = {}) {
  let open = $state(false);
  let active = $state<SettingsTab>("general");
  let hostId = $state<string | null>(null);
  let target = $state<"local" | "server">("local");
  let saving = $state(false);
  const drafts = new SvelteMap<string, SettingsDraft>();
  const state = {
    get open() { return open; },
    get active() { return active; },
    get hostId() { return hostId; },
    get target() { return target; },
    set target(value: "local" | "server") { target = value; },
    get dirty() { return [...drafts.values()].some(draft => draft.dirty); },
    get busy() { return saving || [...drafts.values()].some(draft => draft.busy); },
    get valid() { return [...drafts.values()].every(draft => !draft.dirty || draft.valid); },
    show(tab: SettingsTab = "general", host: string | null = null) { if (!open) lifecycle.onOpen?.(); active = tab; hostId = host; open = true; },
    select(tab: SettingsTab) { active = tab; hostId = null; },
    close() {
      if (saving) return;
      for (const draft of drafts.values()) draft.reset();
      lifecycle.onClose?.();
      open = false;
    },
    register(id: string, draft: SettingsDraft) {
      drafts.set(id, draft);
      return () => { if (drafts.get(id) === draft) drafts.delete(id); };
    },
    async save(): Promise<boolean> {
      if (state.busy || !state.valid) return false;
      saving = true;
      try {
        for (const draft of drafts.values()) if (draft.dirty && !await draft.save()) return false;
        return true;
      } finally { saving = false; }
    },
  };
  setContext(KEY, state);
  return state;
}
export type SettingsState = ReturnType<typeof provideSettings>;
export function useSettings(): SettingsState | undefined { return getContext(KEY); }

/** Old links and bookmarks use the same dialog without unmounting the dashboard. */
export function settingsLocation(url: URL): { tab: SettingsTab; host?: string; target?: "server" } | null {
  const path = url.pathname;
  if (path === "/preferences") {
    const tab = url.searchParams.get("tab");
    return { tab: tab === "general" || tab === "advanced" ? tab : "terminal" };
  }
  if (path === "/hosts" || /^\/hosts\/[^/]+$/.test(path)) return { tab: "hosts", host: path.split("/")[2] };
  if (path === "/settings") return { tab: "fleet", target: url.searchParams.get("scope") === "server" ? "server" : undefined };
  if (path === "/access") return { tab: "access" };
  if (path === "/connection") return { tab: "connection" };
  const tab = url.searchParams.get("preferences");
  if (["general", "terminal", "hosts", "fleet", "access", "connection", "advanced"].includes(tab ?? "")) return { tab: tab as SettingsTab, host: url.searchParams.get("host") ?? undefined, target: url.searchParams.get("scope") === "server" ? "server" : undefined };
  return null;
}
