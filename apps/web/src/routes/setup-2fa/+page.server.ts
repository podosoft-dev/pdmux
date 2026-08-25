import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { requireBackendAvailable } from "#lib/server/guards.js";

// The mandatory two-factor enrolment page (reached via the require-2fa gate).
// Must be signed in; already-enrolled users have nothing to do here.
export const load: PageServerLoad = ({ locals }) => {
  requireBackendAvailable(locals);
  if (!locals.user) redirect(302, "/login");
  const user = locals.user as App.Locals["user"] & { twoFactorEnabled?: boolean };
  if (user.twoFactorEnabled) redirect(302, "/account");
  return { user: locals.user };
};
