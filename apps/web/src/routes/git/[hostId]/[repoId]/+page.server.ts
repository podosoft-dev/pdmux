import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { requireBackendAvailable } from "$lib/server/guards";
import type { HostView } from "$lib/dashboard/types";

/** The dock's own route, so `[↗]` opens the same view in a window of its own. */
export const load: PageServerLoad = async ({ locals, params, url, fetch }) => {
  requireBackendAvailable(locals);
  if (!locals.user) redirect(303, `/login?redirect=${encodeURIComponent(url.pathname)}`);

  let hosts: HostView[] = [];
  try {
    const response = await fetch("/api/hosts");
    if (response.ok) hosts = (await response.json()) as HostView[];
  } catch {
    // The picker degrades to the host in the URL; the graph still loads.
  }

  return { hostId: params.hostId, repoId: params.repoId, hosts };
};
