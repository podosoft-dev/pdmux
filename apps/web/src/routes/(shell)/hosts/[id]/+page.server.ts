import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params }) => redirect(303, `/?preferences=hosts&host=${encodeURIComponent(params.id)}`);
