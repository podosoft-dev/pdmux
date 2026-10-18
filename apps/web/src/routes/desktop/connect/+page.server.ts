import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { requireBackendAvailable } from "#lib/server/guards.js";
export const load: PageServerLoad = ({ locals, url }) => {
  requireBackendAvailable(locals);
  if (!locals.user) redirect(303, `/login?redirect=${encodeURIComponent(url.pathname + url.search)}`);
  return { query: Object.fromEntries(url.searchParams), userName: locals.user.name };
};
