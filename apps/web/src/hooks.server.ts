import { error, type RequestEvent } from "@sveltejs/kit";
import type { Handle } from "@sveltejs/kit/hooks";
import { building } from "$app/env";
import { routes } from "$app/manifest";
import { serverApiClient } from "#lib/server/api.js";
import { resolveLocale } from "#lib/i18n/messages.js";
import { applySearchIndexingHeaders } from "#lib/server/search-indexing.js";
import { isPublicPath } from "#lib/server/guards.js";
import { needsRuntimeContext } from "#lib/server/runtime-context.js";
import type { SiteSettings } from "#lib/site.svelte.js";
import { ApiError } from "@podosoft/podokit-api-client";

function isTemporaryServiceFailure(cause: unknown): boolean {
  if (!(cause instanceof ApiError)) return true;
  return cause.statusCode === 408 || cause.statusCode === 429 || cause.statusCode >= 500;
}

// An anonymous visitor with no site settings, for responses that render no
// layout. The locale still follows the visitor's cookie.
function setEmptyRuntimeContext(event: RequestEvent): void {
  event.locals.site = null;
  event.locals.siteUnavailable = false;
  event.locals.user = null;
  event.locals.session = null;
  event.locals.authUnavailable = false;
  event.locals.locale = resolveLocale(event.cookies.get("locale"));
}

async function loadRuntimeContext(event: RequestEvent): Promise<void> {
  // Public site settings (branding, locale/timezone defaults, maintenance, …)
  // and the session are independent, so both requests run at once. The
  // settings are loaded once here and reused by the layout load. The async
  // wrappers turn a synchronous client failure into a settled rejection.
  const api = serverApiClient(event);
  const [siteResult, sessionResult] = await Promise.allSettled([
    (async () => api.get<SiteSettings>("/site/settings"))(),
    (async () => api.auth.getSession())(),
  ]);

  event.locals.siteUnavailable = false;
  let site: SiteSettings | null = null;
  if (siteResult.status === "fulfilled") {
    site = siteResult.value;
  } else {
    // A request-level 4xx proves that the backend is reachable. In particular,
    // the require-2FA guard returns 403 until enrolment and must remain able to
    // redirect the user to /setup-2fa instead of being masked as an outage.
    event.locals.siteUnavailable = isTemporaryServiceFailure(siteResult.reason);
  }
  event.locals.site = site;
  // A visitor with no locale cookie falls back to the admin-configured site
  // locale, then the app default.
  event.locals.locale = resolveLocale(event.cookies.get("locale") ?? site?.locale ?? undefined);

  event.locals.user = null;
  event.locals.session = null;
  event.locals.authUnavailable = false;
  if (sessionResult.status === "fulfilled") {
    const { data, error } = sessionResult.value;
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
  } else {
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
}

export const handle: Handle = async ({ event, resolve }) => {
  // Listed asset endpoints, missing subresources, the API proxy, and
  // prerendering skip the two API lookups. Pages, their data, form actions,
  // remote functions, and the 404 page get the complete runtime context.
  const route = routes.find(({ id }) => id === event.route.id);
  if (needsRuntimeContext(event, { building, route })) {
    await loadRuntimeContext(event);
  } else {
    setEmptyRuntimeContext(event);
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
