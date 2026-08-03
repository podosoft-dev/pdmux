import { loadAccountData } from "$lib/account-data.server";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals, fetch }) => loadAccountData(locals, fetch);
