import { error, redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { requireBackendAvailable } from "#lib/server/guards.js";
import type {
  AgentTokenView,
  FleetScopeView,
  FleetSettingsView,
  HostGitRootView,
  HostServiceView,
  HostView,
  RepoRow,
} from "#lib/dashboard/types.js";

/**
 * One host: what it exposes (services), where its agent looks for checkouts
 * (git roots) and what lets it in (tokens).
 *
 * ⚠ THE REPO LIST IS LOADED FOR THE GIT-ROOTS CARD, not to draw a graph. It is
 * the only evidence on this page that a typed path was the right one — a found
 * count next to a path is what turns a form field into a confirmed setting.
 */
export const load: PageServerLoad = async ({ locals, params, url, fetch }) => {
  requireBackendAvailable(locals);
  if (!locals.user) redirect(303, `/login?redirect=${encodeURIComponent(url.pathname)}`);

  const response = await fetch(`/api/hosts/${params.id}`);
  if (!response.ok) error(response.status === 404 ? 404 : 502, "Host unavailable");
  const host = (await response.json()) as HostView;

  const readList = async <T>(path: string): Promise<T[]> => {
    try {
      const res = await fetch(path);
      return res.ok ? ((await res.json()) as T[]) : [];
    } catch {
      return [];
    }
  };

  const [services, gitRoots, repos, tokens, scope, fleet] = await Promise.all([
    readList<HostServiceView>(`/api/hosts/${params.id}/services`),
    readList<HostGitRootView>(`/api/hosts/${params.id}/git-roots`),
    readList<RepoRow>(`/api/hosts/${params.id}/repos`),
    readList<AgentTokenView>(`/api/hosts/${params.id}/tokens`),
    // Same question as the shell asks, and the same fail-closed default: whether this
    // session may change the fleet depends on the active organization, which a loader
    // cannot see. Asking keeps one copy of the rule.
    (async (): Promise<FleetScopeView> => {
      try {
        const res = await fetch("/api/fleet/scope");
        return res.ok ? ((await res.json()) as FleetScopeView) : { personal: false, canManage: false };
      } catch {
        return { personal: false, canManage: false };
      }
    })(),
    // The fleet list is what a host with no rows of its own is actually using,
    // and the empty state has to say which of the two silences it is in. The
    // scan interval comes along because it is how long a just-added path may
    // honestly answer "nobody has looked yet".
    (async (): Promise<{ gitRoots: string[]; gitIntervalSec: number }> => {
      try {
        const res = await fetch("/api/fleet/settings");
        if (!res.ok) return { gitRoots: [], gitIntervalSec: 120 };
        const settings = (await res.json()) as FleetSettingsView;
        return { gitRoots: settings.gitRoots ?? [], gitIntervalSec: settings.gitIntervalSec ?? 120 };
      } catch {
        return { gitRoots: [], gitIntervalSec: 120 };
      }
    })(),
  ]);

  return {
    host,
    services,
    gitRoots,
    repos,
    tokens,
    fleetGitRoots: fleet.gitRoots,
    gitIntervalSec: fleet.gitIntervalSec,
    canManage: scope.canManage,
  };
};
