/**
 * The shell's shared state: the live fleet, the user's layout, and the two
 * long-lived clients (terminal relay, commit dock).
 *
 * WHY IT IS NOT PAGE STATE: the host sidebar is rendered by the `(shell)` layout and
 * the terminal grid by the dashboard page, but both read ONE document — the same
 * `TerminalLayout` carries the sidebar's width and the grid's slots, and the same feed
 * draws the cards on every page in the group. Owned by a page, a navigation to
 * `/hosts` would blank the cards, drop the poll and re-seed the layout from the server
 * on the way back.
 *
 * WHY CONTEXT AND NOT A MODULE SINGLETON: module state is shared by every request
 * during SSR, so one user's fleet would render into another user's first paint. A
 * context value is created per component tree — per request on the server, once per
 * navigation-group on the client, which is exactly the lifetime the shell needs.
 */
import { getContext, setContext } from "svelte";
import { browser } from "$app/environment";
import {
  type CardPrefsMap,
  type CardWidget,
  type TerminalLayout,
  defaultLayout,
  normalizeLayout,
  starterCells,
  toggleCardCollapsed,
  toggleCardWidget,
} from "@pdmux/core";
import { hostsApi, prefsApi } from "./api";

/** The regions a narrow screen switches between. `page` is whatever a non-dashboard
 *  route rendered, so `/hosts` and `/account` need no tab of their own. */
export type ShellView = "hosts" | "terminal" | "git" | "page";
import { FleetFeed } from "./fleet-feed.svelte";
import { FilesDock } from "./files-dock.svelte";
import { GitDock } from "./git-dock.svelte";
import { gridHosts } from "./map";
import {
  LAYOUT_NAME,
  type LayoutSaver,
  createLayoutSaver,
  mergeHostPrefs,
  pickLayoutPayload,
  readCachedLayout,
  writeCachedLayout,
} from "./layout-store";
import { TerminalRelay, defaultRelayUrl, type RelayMessages, type RelayStatus } from "./terminal-relay";
import type { FleetSettingsView, HostView, PrefsView } from "./types";

/** What the server load hands the shell, plus the wording the app owns. */
export interface ShellSeed {
  hosts: HostView[];
  /**
   * False when the host request failed, so `hosts: []` means "unknown" and not
   * "empty". Load-bearing: the layout is hydrated against this list, and reading a
   * failed request as an empty fleet drops every slot (`normalizeLayout`).
   */
  hostsOk?: boolean;
  prefs: PrefsView;
  /** False when the prefs request failed — then, and only then, the cache speaks. */
  prefsOk?: boolean;
  fleet: FleetSettingsView;
  /** Relay notices are user-facing text, so they come from the app's i18n. */
  relayMessages: Partial<RelayMessages>;
}

/**
 * The first layout: what the server has for this user, else the cached one, else the
 * starter arrangement seeded from the fleet. `normalizeLayout` is what makes this safe —
 * a corrupt row or a slot on a host that no longer exists becomes an empty cell instead
 * of a broken page.
 *
 * `fresh` reports that the starter arrangement was used, i.e. NOTHING was stored. The
 * constructor writes that one case back, because a fallback nobody persists is a screen
 * the user cannot keep — and it is keyed on "nothing stored" rather than "every cell is
 * empty" so a grid the user deliberately emptied is not re-seeded on every load.
 */
export function initialLayout(seed: ShellSeed): { layout: TerminalLayout; fresh: boolean } {
  /**
   * Server first, and the cache ONLY when the server could not be asked.
   *
   * Measured: with the saved row deleted, a stale cache restored 27 cells and a dock the
   * user had closed — and the write-back below then put that back on the server. A cache
   * that can outvote the source of truth is not a cache.
   */
  const cached = browser && seed.prefsOk === false ? readCachedLayout(window.localStorage) : null;
  const stored = pickLayoutPayload(seed.prefs) ?? cached;
  const hosts = gridHosts(seed.hosts);
  /**
   * A failed host request must not read as an empty fleet — that drops every slot and
   * the first interaction afterwards saves the emptied grid. See `normalizeLayout`.
   */
  const fleetKnown = seed.hostsOk !== false;
  const hydrated = normalizeLayout(stored ?? defaultLayout(), hosts, { fleetKnown });
  return {
    layout: {
      ...hydrated,
      slots: stored ? hydrated.slots : starterCells(hosts),
      cards: mergeHostPrefs(hydrated.cards, seed.prefs?.hostPrefs),
    },
    // Nothing stored AND no fleet to seed from is not a starter arrangement worth
    // keeping — persisting it would make an outage the user's saved empty screen,
    // and "nothing stored" is what lets the real one seed on the next good load.
    fresh: !stored && fleetKnown,
  };
}

export class ShellState {
  readonly feed: FleetFeed;
  readonly dock = new GitDock();
  readonly files = new FilesDock();
  readonly relay: TerminalRelay;
  /** Usage providers the fleet reports; the cards render a row per provider. */
  readonly providers: readonly string[];

  layout = $state<TerminalLayout>(defaultLayout());
  relayStatus = $state<RelayStatus>("idle");
  /**
   * Which region a narrow screen is showing.
   *
   * Deliberately NOT part of `TerminalLayout`: that document is persisted per user and
   * shared across devices, so a phone's current tab would travel to a desktop that has
   * no tabs, and every tap would put a write on the wire. It is per device and per
   * visit; the browser's history is what makes it survive a Back press.
   *
   * Defaults to the terminals — the reason someone opens this app on a phone.
   */
  view = $state<ShellView>("terminal");

  private readonly saver: LayoutSaver;

  constructor(seed: ShellSeed) {
    this.feed = new FleetFeed({ initialHosts: seed.hosts, heartbeatSec: seed.fleet.heartbeatSec });
    this.providers = seed.fleet.usageProviders;
    this.relay = new TerminalRelay({
      url: browser ? defaultRelayUrl(window.location) : "",
      messages: seed.relayMessages,
      onStatus: (status: RelayStatus) => (this.relayStatus = status),
    });
    const initial = initialLayout(seed);
    this.layout = initial.layout;
    this.saver = createLayoutSaver({
      save: async (next: TerminalLayout) => {
        writeCachedLayout(browser ? window.localStorage : null, next);
        await prefsApi.putLayout(LAYOUT_NAME, next as unknown as Record<string, unknown>);
      },
    });
    // Store the starter arrangement once, so "what I see on my first visit" is also
    // "what I get after logging in again". Only when nothing was stored: writing a
    // hydrated layout back here would churn the row on every page load, and the server
    // copy is shared across the user's devices — a phone must not overwrite it.
    if (browser && initial.fresh) this.saver.queue(initial.layout);
  }

  /** Every layout mutation goes through here so persistence can never be forgotten. */
  apply(next: TerminalLayout): void {
    this.layout = next;
    this.saver.queue(next);
  }

  /**
   * Delete a host, then make the screen stop pretending it is there.
   *
   * WHY IT IS THE SHELL'S JOB AND NOT THE ASKING SCREEN'S: removal is more than a
   * request. The API takes the host's tokens with it and closes the agent's socket
   * (`4004 host deleted`), so a pane still pointed at that host would sit in the grid
   * claiming to be connected to a machine this server will now refuse — and the fleet
   * and the layout are both owned here, by the one object both callers share (the
   * card's own menu in the sidebar, and the host list's row menu).
   *
   * The feed is refreshed BEFORE the layout is pruned, because "which hosts exist" is
   * the input to that decision.
   */
  async removeHost(hostId: string): Promise<void> {
    await hostsApi.remove(hostId);
    await this.feed.refresh();
    this.pruneLayout();
  }

  /**
   * Demote every slot whose host is gone to an empty cell.
   *
   * `normalizeLayout` is the same guard that runs on load, so a host deleted in
   * another tab already resolves this way on the next visit — this applies the rule
   * the moment the fleet changes instead. It preserves the ids of the slots it keeps,
   * which is what stops the surviving panes from re-mounting (and dropping their
   * terminals) every time a host is removed.
   *
   * No change, no write: `apply` persists, and a debounced PUT for an identical
   * document is a request that buys nothing.
   */
  private pruneLayout(): void {
    // Only prune against a fleet we actually read. `feed.refresh()` keeps the previous
    // list when a poll fails, so an error here means the list may be a stale `[]` from
    // a failed seed — and pruning against that empties the grid permanently.
    const next = normalizeLayout(this.layout, gridHosts(this.feed.hosts), {
      fleetKnown: this.feed.error === null,
    });
    const shape = (layout: TerminalLayout): string =>
      JSON.stringify([layout.slots, layout.zoomId, layout.focusId, layout.page]);
    if (shape(next) === shape(this.layout)) return;
    this.apply(next);
  }

  toggleWidget(hostId: string, widget: CardWidget): void {
    this.writeCard(hostId, toggleCardWidget(this.layout.cards, hostId, widget));
  }

  toggleCollapsed(hostId: string): void {
    this.writeCard(hostId, toggleCardCollapsed(this.layout.cards, hostId));
  }

  /**
   * Adopt a new card map and push the one row that changed.
   *
   * The per-host row is the authoritative copy for a single card, so it is written
   * immediately rather than waiting for the debounced whole-layout save. It carries the
   * WHOLE row — widgets and fold together — because `PUT /prefs/hosts/:id` replaces the
   * stored object rather than merging into it.
   */
  private writeCard(hostId: string, cards: CardPrefsMap): void {
    this.apply({ ...this.layout, cards });
    void prefsApi.putHostPref(hostId, (cards[hostId] ?? {}) as Record<string, unknown>).catch(() => {
      // A failed preference write is not worth interrupting the screen for; the
      // layout save carries the same value moments later.
    });
  }

  /**
   * Wake the transport when the tab is looked at again.
   *
   * ⚠ A PHONE DOES NOT TELL THE PAGE IT IS GOING TO SLEEP, IT JUST STOPS RUNNING IT. Timers
   * freeze, the socket dies quietly, and nothing on screen changes — so the pane the operator
   * left running shows its last frame and reads as a session that stalled. `pageshow` covers
   * iOS restoring the page from its cache (where no `visibilitychange` fires at all) and
   * `visibilitychange` covers the ordinary return to the tab.
   */
  private readonly wake = (): void => {
    if (document.visibilityState !== "visible") return;
    this.relay.wake();
  };

  start(): void {
    this.feed.start();
    if (browser) {
      window.addEventListener("pageshow", this.wake);
      document.addEventListener("visibilitychange", this.wake);
    }
  }

  /** Called when the shell itself unmounts — leaving the group, not changing page. */
  stop(): void {
    this.feed.stop();
    if (browser) {
      window.removeEventListener("pageshow", this.wake);
      document.removeEventListener("visibilitychange", this.wake);
    }
    this.saver.flush();
    this.saver.dispose();
    this.relay.dispose();
  }
}

const SHELL_KEY = Symbol("pdmux.shell");

/** Called once, by the `(shell)` layout. */
export function provideShellState(seed: ShellSeed): ShellState {
  const state = new ShellState(seed);
  setContext(SHELL_KEY, state);
  return state;
}

export function useShellState(): ShellState {
  const state = getContext<ShellState | undefined>(SHELL_KEY);
  if (!state) throw new Error("useShellState() outside the (shell) layout");
  return state;
}
