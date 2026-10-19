import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ parent }) => {
  if (!(await parent()).desktopStatus.local) redirect(303, "/settings");
  return {};
};
