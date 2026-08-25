import type { LayoutServerLoad } from "./$types";
import { loadProtectedLayout } from "#lib/server/protected-layout.js";

export const load: LayoutServerLoad = async ({ locals, fetch }) => {
  return loadProtectedLayout({ locals, fetch });
};
