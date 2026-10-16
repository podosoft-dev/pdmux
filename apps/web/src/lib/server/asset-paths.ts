/**
 * Application-owned prefixes for `+server.ts` endpoints that serve files, feeds,
 * or other responses needing neither the session nor the site settings (for
 * example "/docs" when an endpoint serves documentation files). A listed path
 * also covers its subpaths. When an endpoint under a listed prefix answers a
 * request, hooks.server.ts skips its two API lookups and the endpoint sees an
 * anonymous `locals.user`. A `+page` under a listed prefix still gets the
 * session and site settings, so it keeps its sign-in and maintenance checks.
 * PodoKit creates this file once and never overwrites it.
 */
export const APP_ASSET_PATHS: readonly string[] = [];
