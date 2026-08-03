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
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("BETTER_AUTH_URL must use HTTPS in production");
  }
  return resolved;
}
