import { APP_NON_INDEXABLE_PATHS } from "./non-indexable-paths";

const NON_INDEXABLE_PATH_PREFIXES = [
  "/api",
  "/admin",
  "/account",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/pending-approval",
  "/setup-2fa",
  "/oauth2",
  "/accept-invitation",
  "/maintenance",
  // Application prefixes from the app-owned non-indexable-paths.ts.
  ...APP_NON_INDEXABLE_PATHS,
];

function matchesPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function shouldPreventSearchIndexing(pathname: string): boolean {
  return NON_INDEXABLE_PATH_PREFIXES.some((prefix) => matchesPathPrefix(pathname, prefix));
}

export function applySearchIndexingHeaders(response: Response, pathname: string): Response {
  if (shouldPreventSearchIndexing(pathname)) {
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return response;
}
