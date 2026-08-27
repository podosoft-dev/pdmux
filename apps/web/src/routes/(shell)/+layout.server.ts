import { redirect } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";
import { requireBackendAvailable } from "#lib/server/guards.js";
import { looksLikePhone } from "#lib/server/phone-hint.js";
import { FLEET_SETTING_FALLBACK } from "#lib/dashboard/fleet-settings.js";
import type { FleetScopeView, FleetSettingsView, HostView, PrefsView } from "#lib/dashboard/types.js";

/**
 * What the product's shell needs, loaded once for every page inside it.
 *
 * The dashboard (`/`) and host management (`/hosts`) share a sidebar, so they share a
 * loader: the fleet, this user's stored screen and the collector's cadence are shell
 * data, not page data. Reading them per page would fetch the same three documents
 * twice and let the two screens disagree about the fleet.
 *
 * The guard order matters: `requireBackendAvailable` first, because a backend we cannot
 * reach must answer 503 rather than "log in" — bouncing a signed-in user to the login
 * page during an outage is how sessions get thrown away for no reason.
 */
const EMPTY_PREFS: PrefsView = { layouts: [], hostPrefs: {} };
/**
 * The whole settings document, not the four fields the cards read.
 *
 * `/settings` renders every one of them, so a fallback that carried a subset would
 * leave the screen typed for values it could not have. It is the mirror of the API's
 * own defaults and lives beside the bounds it belongs with (`fleet-settings.ts`).
 */
const FLEET_FALLBACK: FleetSettingsView = FLEET_SETTING_FALLBACK;

/**
 * Fail closed. If we could not ask whether this session may change the fleet, draw
 * no controls — an affordance that leads to a 403 is worse than no affordance
 * (`HostSidebar` states the same rule for its add tile).
 */
const SCOPE_FALLBACK: FleetScopeView = { personal: false, canManage: false };

/** First paint should not wait on a slow collector: a failed read falls back. */
async function readJson<T>(fetcher: typeof fetch, path: string, fallback: T): Promise<{ value: T; ok: boolean }> {
  try {
    const response = await fetcher(path);
    if (!response.ok) return { value: fallback, ok: false };
    return { value: (await response.json()) as T, ok: true };
  } catch {
    return { value: fallback, ok: false };
  }
}


export const load: LayoutServerLoad = async ({ locals, url, fetch, request }) => {
  requireBackendAvailable(locals);
  if (!locals.user) redirect(303, `/login?redirect=${encodeURIComponent(url.pathname)}`);

  // This product shell owns `/account`, so it does not pass through PodoKit's
  // `(app)` layout where the enrolment redirect normally lives. Keep the API guard
  // authoritative and provide the same UX here before protected shell calls are made.
  const user = locals.user as App.Locals["user"] & { twoFactorEnabled?: boolean };
  if (!user.twoFactorEnabled) {
    let mustEnrol = false;
    try {
      const response = await fetch("/api/account/require-2fa");
      mustEnrol = response.ok &&
        ((await response.json()) as { require2fa?: boolean }).require2fa === true;
    } catch {
      // The backend guard still fails closed if the policy endpoint is unavailable.
    }
    if (mustEnrol) redirect(302, "/setup-2fa");
  }

  const [hosts, prefs, fleet, scope] = await Promise.all([
    readJson<HostView[]>(fetch, "/api/hosts", []),
    readJson<PrefsView>(fetch, "/api/prefs", EMPTY_PREFS),
    readJson<FleetSettingsView>(fetch, "/api/fleet/settings", FLEET_FALLBACK),
    readJson<FleetScopeView>(fetch, "/api/fleet/scope", SCOPE_FALLBACK),
  ]);

  // Any member may look at the fleet — they work on these machines every day. Who may
  // CHANGE it is the API's answer, not ours: an administrator anywhere, and anyone in
  // their own personal scope, where the fleet is their own machines. The rule needs the
  // active organization, which this loader cannot see (`locals.session` carries an id
  // and nothing else), so asking is also the only way to get it right. The screens hide
  // the controls that would answer 403; the API enforces it independently.
  //
  // `user` is re-stated (the root layout already carries it) because the redirect above
  // makes it non-null for everything in this group: the account screen hands it to a
  // component that requires a session, and a nullable type there would be a lie.
  /**
   * `prefsOk` distinguishes "this user has no saved layout" from "we could not ask".
   *
   * Both used to arrive as an empty `PrefsView`, and the shell then fell back to its
   * localStorage cache — which resurrected a layout that had been deliberately deleted and
   * wrote it back to the server. The cache is for an outage, not for overriding the truth.
   */
  /**
   * `hostsOk` distinguishes "this fleet has no hosts" from "we could not ask" — the
   * same distinction as `prefsOk`, and for a sharper reason. The layout is hydrated
   * against this list, and a slot whose host is absent is dropped; with the `[]`
   * fallback above, one failed request therefore reads as "every host was deleted"
   * and empties the user's grid, which the next interaction then saves. Twice on
   * 2026-07-27 that cost a full screen of terminals (`normalizeLayout`).
   */
  return {
    user: locals.user,
    impersonating: Boolean(locals.session?.impersonatedBy),
    hosts: hosts.value,
    hostsOk: hosts.ok,
    /** First-paint hint only — see `looksLikePhone`. The media query owns this after hydration. */
    phoneHint: looksLikePhone(request),
    prefs: prefs.value,
    prefsOk: prefs.ok,
    /**
     * Merged onto the defaults rather than passed through raw. The type says every
     * setting is present, and the settings screen seeds a form from it — so an API that
     * predates one of them must leave a default in the box, not the word `undefined`.
     * `readJson`'s fallback IS this object, so the merge is idempotent on failure.
     */
    fleet: { ...FLEET_SETTING_FALLBACK, ...fleet.value },
    /**
     * `fleetOk` distinguishes "these are the fleet's settings" from "we could not ask",
     * and only the settings screen can act on the difference — the cards read the
     * cadence either way, but a FORM seeded from the fallback is a screen full of
     * defaults that looks exactly like a screen full of the operator's values. Pressing
     * Save on it would write the defaults over whatever the fleet actually had.
     */
    fleetOk: fleet.ok,
    canManage: scope.value.canManage,
  };
};
