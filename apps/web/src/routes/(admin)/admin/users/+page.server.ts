import type { PageServerLoad } from "./$types";
import { requireAdmin } from "$lib/server/guards";

export const load: PageServerLoad = ({ locals }) => {
  requireAdmin(locals.user, locals);
  return { currentUserId: locals.user!.id };
};
