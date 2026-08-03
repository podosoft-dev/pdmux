import type { LayoutServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";
import { safeAuthRedirect } from "$lib/auth-redirect";
import { loadMessages } from "$lib/i18n/messages";
import { isPublicPath, requireBackendAvailable } from "$lib/server/guards";
import type { Capabilities } from "@podosoft/podokit-api-client";

// "/" is a public landing page. Auth pages return signed-in users to their safe
// requested page, and the admin area requires a session. /maintenance is public
// so it renders while the rest of the site is held back.
const AUTH_PATHS = ["/login", "/signup", "/forgot-password", "/reset-password"];

export const load: LayoutServerLoad = async (event) => {
  const { locals, url } = event;
  const { pathname } = url;
  // Site settings were loaded once in hooks.server.ts.
  const site = locals.site;
  const isAdmin = locals.user?.role === "admin";

  // Authentication and maintenance policy are both security boundaries. If
  // either could not be checked, deny protected content without redirecting to
  // login or modifying the session cookie. Public pages keep their static fallbacks.
  if (!isPublicPath(pathname)) requireBackendAvailable(locals);

  // Maintenance mode holds everyone but admins on a maintenance page. /login and
  // /maintenance stay reachable so an admin can still sign in and turn it off.
  const maintenance = site?.maintenanceMode === "true";
  if (maintenance && !isAdmin && pathname !== "/maintenance" && pathname !== "/login") {
    redirect(303, "/maintenance");
  }
  if (!locals.siteUnavailable && !maintenance && pathname === "/maintenance") {
    redirect(303, "/");
  }
  // Registration closed from the admin Settings: send /signup back to /login.
  if (site?.allowSignup === "false" && pathname === "/signup") {
    const returnTo = safeAuthRedirect(url.searchParams.get("redirect"));
    redirect(303, `/login?redirect=${encodeURIComponent(returnTo)}`);
  }

  if (locals.user && AUTH_PATHS.includes(pathname)) {
    redirect(303, safeAuthRedirect(url.searchParams.get("redirect")));
  }
  if (!locals.user && !isPublicPath(pathname)) {
    redirect(303, `/login?redirect=${encodeURIComponent(`${pathname}${url.search}`)}`);
  }
  let sessionIdleTimeoutMinutes: number | null = null;
  if (locals.user) {
    try {
      const response = await event.fetch("/api/account/capabilities");
      if (response.ok) {
        const capabilities = (await response.json()) as Capabilities;
        sessionIdleTimeoutMinutes = capabilities.sessionIdleTimeoutMinutes ?? null;
      }
    } catch {
      // Keep automatic logout disabled in the browser if policy lookup fails.
      // The server-side session expiration remains authoritative.
    }
  }
  const messages = await loadMessages(locals.locale, site?.locale);
  return { user: locals.user, locale: locals.locale, messages, site, sessionIdleTimeoutMinutes };
};
