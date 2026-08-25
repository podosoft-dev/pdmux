import type { LayoutServerLoad } from "./$types";
import { loadProtectedLayout } from "#lib/server/protected-layout.js";
import { requireAdmin } from "#lib/server/guards.js";

export const load: LayoutServerLoad = async ({ locals, fetch }) => {
  requireAdmin(locals.user, locals);
  return loadProtectedLayout({ locals, fetch });
};
