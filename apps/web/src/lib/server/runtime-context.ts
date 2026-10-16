import { APP_ASSET_PATHS } from "./asset-paths";

/** The request fields that decide whether a response can use the session and site settings. */
export interface RuntimeContextRequest {
  url: URL;
  route: { id: string | null };
  request: Request;
  isDataRequest: boolean;
  isRemoteRequest: boolean;
}

// Fetch destinations that SvelteKit answers with a plain-text 404, without the
// root layout, when no route matches.
const SUBRESOURCE_DESTINATIONS = new Set([
  "audio",
  "audioworklet",
  "font",
  "image",
  "json",
  "manifest",
  "paintworklet",
  "report",
  "script",
  "serviceworker",
  "sharedworker",
  "style",
  "track",
  "video",
  "webidentity",
  "worker",
  "xslt",
]);

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || (prefix !== "/" && pathname.startsWith(`${prefix}/`));
}

/**
 * True when an Accept header ranks HTML ahead of the wildcard. This mirrors how
 * SvelteKit chooses between a page and an endpoint on the same route.
 */
export function prefersHtml(accept: string | null): boolean {
  const ranges = (accept ?? "*/*")
    .split(",")
    .map((part, index) => {
      const [range = "", ...params] = part.trim().toLowerCase().split(";");
      const quality = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
      return { range: range.trim(), q: quality ? Number(quality.slice(2)) : 1, index };
    })
    .filter(({ range, q }) => range.includes("/") && q > 0)
    .sort((a, b) => b.q - a.q || specificity(b.range) - specificity(a.range) || a.index - b.index);
  const html = ranges.findIndex(({ range }) => range === "text/html" || range === "text/*");
  const wildcard = ranges.findIndex(({ range }) => range === "*/*");
  return html !== -1 && (wildcard === -1 || html < wildcard);
}

function specificity(range: string): number {
  if (range === "*/*") return 0;
  return range.endsWith("/*") ? 1 : 2;
}

/** Which files the matched route has, from `routes` in `$app/manifest`. */
export interface RouteFiles {
  page: boolean;
  endpoint: boolean;
}

/** True when SvelteKit answers the request with the route's `+page` rather than its `+server`. */
function answeredByPage(event: RuntimeContextRequest, route: RouteFiles | undefined): boolean {
  if (route && !route.page) return false;
  if (route && !route.endpoint) return true;
  if (event.isDataRequest) return true;
  const { headers, method } = event.request;
  if (method !== "GET" && method !== "HEAD" && method !== "POST") return false;
  if (method === "POST" && headers.get("x-sveltekit-action") === "true") return true;
  return prefersHtml(headers.get("accept"));
}

/**
 * Decide whether hooks.server.ts must load the session and the site settings
 * before SvelteKit answers the request. It skips them only when the response
 * cannot render a layout, or when the application listed the path in
 * APP_ASSET_PATHS and a `+server` endpoint, not a `+page`, answers it.
 */
export function needsRuntimeContext(
  event: RuntimeContextRequest,
  options: { building?: boolean; route?: RouteFiles } = {},
): boolean {
  // Prerendering runs at build time without the API, and the stored HTML must
  // not depend on one visitor's session or on runtime site settings.
  if (options.building) return false;
  const { pathname } = event.url;
  // The backend proxy forwards the cookies; the API resolves the session itself.
  if (underPrefix(pathname, "/api")) return false;
  // Remote functions run application code that may read the session.
  if (event.isRemoteRequest) return true;
  if (event.route.id === null) {
    // SvelteKit renders its 404 page with the root layout, which redirects or
    // greets the visitor, unless the browser fetched a subresource.
    const destination = event.request.headers.get("sec-fetch-dest") ?? "";
    return !SUBRESOURCE_DESTINATIONS.has(destination);
  }
  if (APP_ASSET_PATHS.some((prefix) => underPrefix(pathname, prefix))) {
    return answeredByPage(event, options.route);
  }
  return true;
}
