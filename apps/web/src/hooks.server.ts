import { error } from "@sveltejs/kit";
import type { Handle } from "@sveltejs/kit/hooks";
import { serverApiClient } from "#lib/server/api.js";
import { resolveLocale } from "#lib/i18n/messages.js";
import { applySearchIndexingHeaders } from "#lib/server/search-indexing.js";
import { isPublicPath } from "#lib/server/guards.js";
import type { SiteSettings } from "#lib/site.svelte.js";
import { ApiError } from "@podosoft/podokit-api-client";

function isTemporaryServiceFailure(cause: unknown): boolean {
  if (!(cause instanceof ApiError)) return true;
  return cause.statusCode === 408 || cause.statusCode === 429 || cause.statusCode >= 500;
}

export const handle: Handle = async ({ event, resolve }) => {
  // Static assets and API proxy requests do not render application layouts.
  // Avoid multiplying settings/session API calls for every asset and proxied
  // request; page and data routes still receive the complete runtime context.
  if (event.route.id === null || event.url.pathname.startsWith("/api/")) {
    const response = await resolve(event);
    return applySearchIndexingHeaders(response, event.url.pathname);
  }

  // Public site settings (branding, locale/timezone defaults, maintenance, …),
  // loaded once here and reused by the layout load. A visitor with no locale
  // cookie falls back to the admin-configured site locale, then the app default.
  event.locals.siteUnavailable = false;
  let site: SiteSettings | null = null;
  try {
    site = await serverApiClient(event).get<SiteSettings>("/site/settings");
  } catch (cause: unknown) {
    site = null;
    // A request-level 4xx proves that the backend is reachable. In particular,
    // the require-2FA guard returns 403 until enrolment and must remain able to
    // redirect the user to /setup-2fa instead of being masked as an outage.
    event.locals.siteUnavailable = isTemporaryServiceFailure(cause);
  }
  event.locals.site = site;
  event.locals.locale = resolveLocale(event.cookies.get("locale") ?? site?.locale ?? undefined);

  event.locals.user = null;
  event.locals.session = null;
  event.locals.authUnavailable = false;
  try {
    const { data, error } = await serverApiClient(event).auth.getSession();
    // Better Auth returns HTTP authentication failures as data/error. A 401 is
    // a confirmed anonymous session; every other error means that the session
    // could not be checked and must not be treated as a logout.
    if (error && error.status !== 401) {
      event.locals.authUnavailable = true;
    } else {
      event.locals.user = (data?.user as App.Locals["user"]) ?? null;
      event.locals.session = data?.session
        ? { id: data.session.id, impersonatedBy: (data.session as { impersonatedBy?: string | null }).impersonatedBy ?? null }
        : null;
    }
  } catch {
    // Transport failures do not invalidate the browser's session cookie. A
    // protected loader will fail closed with 503 until the backend recovers.
    event.locals.authUnavailable = true;
  }
  if (
    (event.locals.authUnavailable || event.locals.siteUnavailable) &&
    !isPublicPath(event.url.pathname)
  ) {
    error(503, "Service temporarily unavailable");
  }
  const response = await resolve(event, {
    transformPageChunk: ({ html }) =>
      html.replace(
        /(<html\b[^>]*?\slang=)(["'])[^"']*\2/i,
        `$1"${event.locals.locale}"`,
      ),
  });
  return applySearchIndexingHeaders(response, event.url.pathname);
};
