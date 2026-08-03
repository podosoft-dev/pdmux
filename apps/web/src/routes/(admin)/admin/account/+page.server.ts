import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  return { currentSessionId: locals.session?.id ?? null };
};
