import { json, text, type RequestEvent } from "@sveltejs/kit";
import { dev } from "$app/env";

// SvelteKit's cross-site form check, applied by hooks.server.ts instead of by
// SvelteKit. The built-in check runs before every hook and route and refuses a
// POST, PUT, PATCH, or DELETE that has no content type or one an HTML form can
// send unless its Origin header names this site. Clients that are not browsers,
// such as scripts, CLIs, and MCP clients calling /api with a session cookie or an
// Authorization header, send no Origin, so vite.config.ts turns the built-in
// check off and this one lets such requests on /api through to the API, which
// authenticates them. Browsers send Origin with every request of these methods,
// so a cross-site form or fetch is still refused on /api as on every other path.

/** `csrf.trustedOrigins` from `appSvelteKitConfig` in vite.extensions.ts, set by vite.config.ts. */
declare const __PODOKIT_CSRF_TRUSTED_ORIGINS__: readonly string[] | undefined;

// A config the app owns, such as its own vitest.config.ts, may not define it.
// `typeof` reads an undefined name without throwing, and no trusted origin is the
// strict default: only this site's own forms pass.
const TRUSTED_ORIGINS: readonly string[] =
  typeof __PODOKIT_CSRF_TRUSTED_ORIGINS__ === "undefined" ? [] : __PODOKIT_CSRF_TRUSTED_ORIGINS__;

const FORM_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const FORM_CONTENT_TYPES = new Set([
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
  // SvelteKit's encoding for remote form functions.
  "application/x-sveltekit-formdata",
]);

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Whether a request is a cross-site form submission: SvelteKit's rule, except that
 * a request to /api without an Origin header passes. `url` is the URL SvelteKit
 * resolved, whose origin is this site's (`paths.origin` when the build sets it).
 */
export function isCrossSiteFormSubmission(
  request: Request,
  url: URL,
  trustedOrigins: readonly string[] = TRUSTED_ORIGINS,
): boolean {
  if (!FORM_METHODS.has(request.method) || trustedOrigins.includes("*")) return false;
  const contentType = request.headers.get("content-type");
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType && !FORM_CONTENT_TYPES.has(mediaType)) return false;
  const origin = request.headers.get("origin");
  if (origin === url.origin) return false;
  if (origin === null) return !isApiPath(url.pathname);
  return !trustedOrigins.includes(origin);
}

/**
 * SvelteKit's 403 for a cross-site form submission, or null to handle the request.
 * Like SvelteKit's check, it does not run on the Vite dev server.
 */
export function refuseCrossSiteForm(event: RequestEvent): Response | null {
  if (dev || !isCrossSiteFormSubmission(event.request, event.url)) return null;
  const message = `Cross-site ${event.request.method} form submissions are forbidden`;
  return event.request.headers.get("accept") === "application/json"
    ? json({ message }, { status: 403 })
    : text(message, { status: 403 });
}
