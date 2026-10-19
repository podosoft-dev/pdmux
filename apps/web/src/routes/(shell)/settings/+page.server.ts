import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ url }) => {
  const query = new URLSearchParams({ preferences: "fleet" });
  if (url.searchParams.get("scope") === "server") query.set("scope", "server");
  const tab = url.searchParams.get("tab");
  if (tab) query.set("tab", tab);
  return redirect(303, `/?${query}`);
};
