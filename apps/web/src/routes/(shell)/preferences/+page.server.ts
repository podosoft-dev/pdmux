import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ url }) => {
  const tab = url.searchParams.get("tab");
  redirect(303, `/?preferences=${tab === "general" || tab === "advanced" ? tab : "terminal"}`);
};
