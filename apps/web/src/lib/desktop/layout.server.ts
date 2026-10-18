import { error } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";
import { requireBackendAvailable } from "#lib/server/guards.js";

export function load({ locals }: Pick<RequestEvent, "locals">): Record<string, unknown> {
  requireBackendAvailable(locals);
  if (!locals.user) error(503);
  return { user: locals.user, locale: locals.locale, site: locals.site, sessionIdleTimeoutMinutes: null };
}
