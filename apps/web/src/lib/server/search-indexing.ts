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
  // A shell script and a tree of 8 MB binaries. Public so an unattended machine can
  // fetch them, but there is nothing here for a search index — and an install
  // one-liner surfacing in results is how people run the wrong server's installer.
  "/install.sh",
  "/agent",
] as const;

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
