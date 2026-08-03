import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { SIGNUP_APPROVAL_REQUIRED, type Capabilities } from "@podosoft/podokit-api-client";

// Capabilities is public so the login page can offer whichever sign-in methods
// (magic link, ...) the server actually enabled.
export const load: PageServerLoad = async ({ fetch, url }) => {
  const oauthError = url.searchParams.get("error");
  const idleLogout = url.searchParams.get("reason") === "idle";
  if (oauthError === SIGNUP_APPROVAL_REQUIRED) redirect(302, "/pending-approval");
  try {
    const res = await fetch("/api/account/capabilities");
    if (res.ok) return { capabilities: (await res.json()) as Capabilities, oauthError, idleLogout };
  } catch {
    /* fall through to defaults */
  }
  return { capabilities: null, oauthError, idleLogout };
};
