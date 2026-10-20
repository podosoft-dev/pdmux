import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { requireBackendAvailable } from "#lib/server/guards.js";
import type { FleetScopeView, HostView } from "#lib/dashboard/types.js";
import { normalizeTerminalPresentation } from "@pdmux/core";

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
  let tags: unknown;
  try { tags = JSON.parse((url.searchParams.get("tags") ?? "").slice(0, 4096)); } catch { /* Invalid display metadata never prevents attaching. */ }
  const presentation = normalizeTerminalPresentation({ label: url.searchParams.get("label"), tags });

  let hostLabel = hostId;
  let host: HostView | null = null;
  // Fail closed, as the shell does: a window that could not ask draws no administrator's changes.
  let canManage = false;
  const [hostAnswer, scopeAnswer] = await Promise.allSettled([fetch(`/api/hosts/${hostId}`), fetch("/api/fleet/scope")]);
  try {
    if (hostAnswer.status === "fulfilled" && hostAnswer.value.ok) {
      host = (await hostAnswer.value.json()) as HostView;
      hostLabel = host.label;
    }
  } catch {
    // A missing label costs the window's title, not the terminal.
  }
  try {
    if (scopeAnswer.status === "fulfilled" && scopeAnswer.value.ok) canManage = ((await scopeAnswer.value.json()) as FleetScopeView).canManage === true;
  } catch {
    // Without an answer the window offers what any member may do.
  }

  return { hostId, kind, session, hostLabel, host, backend, sessionId, canManage, presentation };
};
