import { PDMUX_HTTP_ROUTES } from "../pdmux/pdmux.contract";
const forbidden = /\/(?:tokens|enrollments|mcp-keys|exposures|move)(?:\/|$)/;
const routes = PDMUX_HTTP_ROUTES.filter(route => /^(GET|POST|PUT|PATCH|DELETE) \/(?:hosts|terminal)\/:hostId/.test(route)).map(route => {
  const space = route.indexOf(" ");
  return { method: route.slice(0, space), pattern: new RegExp(`^${route.slice(space + 1).replace(/:[A-Za-z]+/g, "[^/]+")}$`) };
});
export function hostRoute(method: string, path: string): { hostId: string; rewrite: (id: string) => string } | null {
  const url = new URL(path, "http://localhost");
  if (url.origin !== "http://localhost" || /%2f|%5c|%2e|\\/i.test(url.pathname) || forbidden.test(url.pathname)) return null;
  const match = /^\/(hosts|terminal)\/([0-9a-f-]{36})(\/.*)?$/i.exec(url.pathname);
  if (!match || !routes.some(route => route.method === method && route.pattern.test(url.pathname))) return null;
  const [, prefix, hostId, rest = ""] = match;
  if (!hostId) return null;
  return { hostId, rewrite: id => `/${prefix}/${encodeURIComponent(id)}${rest}${url.search}` };
}
export function metadataWrite(method: string, path: string): boolean {
  if (method === "GET") return false;
  return /^\/(?:prefs(?:\/|$)|hosts(?:\/[^/]+(?:\/(?:enabled|services|git-roots)(?:\/.*)?)?)?$)/.test(path);
}
