import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { requireBackendAvailable } from "#lib/server/guards.js";
import type { HostView } from "#lib/dashboard/types.js";

/**
 * A pane in its own window.
 *
 * The target travels in the query string rather than in a store: a detached window
 * is opened with `window.open`, survives a reload, and can be bookmarked — none of
 * which works if the only copy of "which session am I" lives in the opener's memory.
 */
export const load: PageServerLoad = async ({ locals, url, fetch }) => {
  requireBackendAvailable(locals);
  if (!locals.user) redirect(303, `/login?redirect=${encodeURIComponent(`${url.pathname}${url.search}`)}`);

  const hostId = url.searchParams.get("host") ?? "";
  const kindParam = url.searchParams.get("kind");
  const kind = kindParam === "shell" || kindParam === "new" ? kindParam : "attach";
  const session = url.searchParams.get("session");

  let hostLabel = hostId;
  try {
    const response = await fetch(`/api/hosts/${hostId}`);
    if (response.ok) hostLabel = ((await response.json()) as HostView).label;
  } catch {
    // A missing label costs the window's title, not the terminal.
  }

  return { hostId, kind, session, hostLabel };
};
