import { error } from "@sveltejs/kit";

/** Roles that may reach the admin console. Kept as a set so custom roles can be
 *  added here (and, later, replaced by a permission check) without touching every
 *  page loader. better-auth stores a user's role(s) as a comma-separated string. */
const ADMIN_ROLES = ["admin"];
const PUBLIC_PATHS = [
  "/",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/pending-approval",
  "/maintenance",
  // Modules add their public (no-session) page prefixes here.
  // podokit:begin:public-paths
  // podokit:end:public-paths
];

type WithRole = { role?: string | null } | null | undefined;
type BackendAvailability = Pick<App.Locals, "authUnavailable" | "siteUnavailable">;

/** True for routes that may render without a confirmed session or site policy. */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || (path !== "/" && pathname.startsWith(`${path}/`)));
}

/** Stop protected loaders when authentication or runtime policy cannot be checked. */
export function requireBackendAvailable(locals: BackendAvailability): void {
  if (locals.authUnavailable || locals.siteUnavailable) {
    error(503, "Service temporarily unavailable");
  }
}

/** True when the user holds at least one admin role. */
export function isAdmin(user: WithRole): boolean {
  const roles = (user?.role ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  return roles.some((r) => ADMIN_ROLES.includes(r));
}

/** Guard an admin-only loader after confirming the backend is available. */
export function requireAdmin(user: WithRole, availability?: BackendAvailability): void {
  if (availability) requireBackendAvailable(availability);
  if (!isAdmin(user)) error(403, "Admins only");
}
