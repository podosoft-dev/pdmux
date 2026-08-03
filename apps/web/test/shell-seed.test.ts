import { describe, expect, it } from "vitest";
import { initialLayout, type ShellSeed } from "../src/lib/dashboard/shell-state.svelte";
import { FLEET_SETTING_FALLBACK } from "../src/lib/dashboard/fleet-settings";
import type { HostView, PrefsView } from "../src/lib/dashboard/types";

/**
 * The seam where a failed request used to destroy a saved screen.
 *
 * `+layout.server.ts` falls back to `hosts: []` when `GET /api/hosts` fails. The layout
 * is hydrated against that list, so read as "the fleet is empty" one bad request drops
 * every slot — and the next thing the user touches persists the emptied grid. It cost a
 * full screen of terminals twice on 2026-07-27 before the cause was found, which is why
 * the wiring (`hostsOk` → `fleetKnown`) is pinned here and not only in `@pdmux/core`.
 */

const HOST: HostView = {
  id: "h1",
  label: "local-dev",
  online: true,
} as unknown as HostView;

const SAVED_SLOTS = [
  { id: "s1", hostId: "h1", kind: "attach", session: "claude-1" },
  { id: "s2", hostId: "h1", kind: "attach", session: "claude-2" },
];

const prefsWith = (slots: unknown[]): PrefsView =>
  ({
    layouts: [{ name: "default", isDefault: true, payload: { mode: "split4", slots, focusId: "s1" } }],
    hostPrefs: {},
  }) as unknown as PrefsView;

const seed = (over: Partial<ShellSeed> = {}): ShellSeed => ({
  hosts: [HOST],
  prefs: prefsWith(SAVED_SLOTS),
  // The shipped defaults, not a hand-built subset: nothing here asserts on a setting,
  // and the mirror stays correct as the settings document grows.
  fleet: FLEET_SETTING_FALLBACK,
  relayMessages: {},
  ...over,
});

describe("[TC-PDWEB-006] a failed host request never empties the saved layout", () => {
  it("keeps the stored slots when the fleet could not be read", () => {
    const { layout, fresh } = initialLayout(seed({ hosts: [], hostsOk: false }));

    expect(layout.slots.map((s) => s?.session ?? null)).toEqual(["claude-1", "claude-2"]);
    // Nothing may be written back either: a starter arrangement seeded from a fleet we
    // could not read is an outage, not a preference.
    expect(fresh).toBe(false);
  });

  it("does not seed-and-save a starter screen during an outage", () => {
    // Nothing stored AND no readable fleet. Persisting the empty starter here would
    // turn a transient failure into this user's saved empty dashboard.
    const { layout, fresh } = initialLayout(
      seed({ hosts: [], hostsOk: false, prefs: { layouts: [], hostPrefs: {} } as unknown as PrefsView }),
    );

    expect(fresh).toBe(false);
    // The grid is empty on screen (there is no fleet to seed from) but `fresh: false`
    // is what matters: nothing is persisted, so the real starter still seeds on the
    // next good load instead of this outage becoming the saved layout.
    expect(layout.slots.filter(Boolean)).toEqual([]);
  });

  it("still honours a real deletion when the fleet WAS read", () => {
    // `hostsOk` true and the host absent is a genuine deletion: the cell empties.
    const { layout } = initialLayout(seed({ hosts: [], hostsOk: true }));
    expect(layout.slots).toEqual([]);

    // And the ordinary case is untouched.
    const ok = initialLayout(seed());
    expect(ok.layout.slots.map((s) => s?.session ?? null)).toEqual(["claude-1", "claude-2"]);
  });
});
