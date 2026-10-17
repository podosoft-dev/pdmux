export function authSecret(): string {
  const value = process.env.BETTER_AUTH_SECRET?.trim();
  if (
    process.env.NODE_ENV === "production" &&
    (!value || value.startsWith("change-me-"))
  ) {
    throw new Error("BETTER_AUTH_SECRET must be set to a non-placeholder value in production");
  }
  const resolved = value || "development-only-auth-secret-min-32-characters";
  if (resolved.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  }
  return resolved;
}

/** A host that only this machine reaches, where plain HTTP exposes nothing. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

export function authBaseUrl(): string {
  const value = process.env.BETTER_AUTH_URL?.trim();
  if (process.env.NODE_ENV === "production" && !value) {
    throw new Error("BETTER_AUTH_URL must be set in production");
  }
  const resolved = value || "http://localhost:5002";
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    throw new Error("BETTER_AUTH_URL must be a valid URL");
  }
  // A loopback URL may stay HTTP, for example an API that a desktop shell runs
  // on 127.0.0.1 in production mode.
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    throw new Error("BETTER_AUTH_URL must use HTTPS in production unless it is a loopback address");
  }
  return resolved;
}
