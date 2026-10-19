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
  const backend = url.searchParams.get("backend") === "native" ? "native" as const : undefined;
  const candidate = url.searchParams.get("sessionId");
  const sessionId = candidate && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate) ? candidate : undefined;

  let hostLabel = hostId;
  let host: HostView | null = null;
  try {
    const response = await fetch(`/api/hosts/${hostId}`);
    if (response.ok) {
      host = (await response.json()) as HostView;
      hostLabel = host.label;
    }
  } catch {
    // A missing label costs the window's title, not the terminal.
  }

  return { hostId, kind, session, hostLabel, host, backend, sessionId };
};
