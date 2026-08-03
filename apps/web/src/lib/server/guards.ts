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
  // The public installer and the release binaries it downloads. The machine being
  // onboarded has no session and nothing installed, so these must answer for an
  // anonymous request — and, more to the point, must keep answering while the API
  // is down: without them here, `hooks.server.ts` turns a backend outage into a 503
  // for `curl -fsSL … | sh`, which prints nothing at all at the operator's end.
  "/install.sh",
  "/agent",
  // The MCP endpoint, for the same reason: its caller is a coding CLI holding a
  // key, not a browser holding a session, and turning a backend blip into a 503
  // HTML page gives an MCP client nothing it can read.
  "/mcp",
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
