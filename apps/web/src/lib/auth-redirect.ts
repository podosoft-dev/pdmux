const AUTH_PATHS = new Set(["/login", "/signup", "/forgot-password", "/reset-password"]);

/** Accept only same-site absolute paths and keep authentication redirects from
 *  becoming open redirects or loops back into an auth screen. */
export function safeAuthRedirect(value: string | null | undefined, fallback = "/"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return fallback;
  }
  try {
    const parsed = new URL(value, "http://podokit.local");
    if (parsed.origin !== "http://podokit.local" || AUTH_PATHS.has(parsed.pathname)) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

/** Current same-site path, suitable for a login return target. */
export function currentPath(url: URL): string {
  return safeAuthRedirect(`${url.pathname}${url.search}${url.hash}`);
}

/** Add a validated return target to an authentication-page link. */
export function withAuthRedirect(authPath: "/login" | "/signup", target: string): string {
  const params = new URLSearchParams({ redirect: safeAuthRedirect(target) });
  return `${authPath}?${params.toString()}`;
}
