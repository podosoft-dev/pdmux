import { AppException } from "@podosoft/podokit-contracts";

/**
 * The parts of a session these helpers read.
 *
 * Structural rather than a framework session type so the same rule serves both an
 * HTTP request and the WebSocket upgrade path (where the session is resolved before
 * the socket is accepted). One scope
 * resolver, two entry points — the alternative is a second copy that drifts.
 */
export interface ScopedSession {
  user?: { id?: string | null; name?: string | null; email?: string | null; role?: string | string[] | null } | null;
  session?: { activeOrganizationId?: string | null } | null;
}

/**
 * Every fleet row (host, service, token, repo, metric) is filed under exactly one
 * scope id.
 *
 * WHY A SYNTHETIC FALLBACK: better-auth sets `activeOrganizationId` only once a
 * user actually belongs to (and has selected) an organization, but a self-hosted
 * install very often runs with one person and no organization at all. Filing those
 * rows under `personal:<userId>` keeps a single scoping rule — a row always has a
 * non-null owner and every query filters on it — instead of a nullable column
 * whose `WHERE organizationId IS NULL` branch is the classic way rows leak between
 * tenants.
 */
export function resolveScopeId(session: ScopedSession): string {
  const orgId = session.session?.activeOrganizationId;
  if (typeof orgId === "string" && orgId.length > 0) return orgId;
  const userId = session.user?.id;
  if (typeof userId === "string" && userId.length > 0) return `personal:${userId}`;
  // A session without a user cannot happen behind AuthGuard; failing closed here
  // means a future code path that forgets the guard cannot read another tenant.
  throw new AppException("FLEET_SCOPE_REQUIRED", "No organization scope for this session", 403);
}

/** App-level admin (the `admin` role from auth/permissions.ts), not an org role. */
export function isAdmin(session: ScopedSession): boolean {
  const role = session.user?.role;
  const roles = Array.isArray(role) ? role : (role ?? "").split(",").map((r: string) => r.trim());
  return roles.includes("admin");
}

/**
 * True when this session's scope is the user's own — no organization selected, so
 * `resolveScopeId` returns `personal:<userId>` and every row it reaches was filed
 * there by this same user.
 *
 * ⚠ REQUIRES A USER, and not as a formality. Without that check a session carrying
 * neither a user nor an organization reads as "personal" — the exact shape of a
 * request that got past the auth guard — and `assertCanManageFleet` below would
 * grant it write access to a scope nobody owns. `resolveScopeId` fails closed on the
 * same input for the same reason.
 */
export function isPersonalScope(session: ScopedSession): boolean {
  const userId = session.user?.id;
  if (typeof userId !== "string" || userId.length === 0) return false;
  const orgId = session.session?.activeOrganizationId;
  return !(typeof orgId === "string" && orgId.length > 0);
}

/**
 * Who may change the fleet.
 *
 * An ORGANIZATION's fleet is shared, so changing it stays an administrator's job:
 * a member who renames a host or revokes a token changes it for colleagues who are
 * working on those machines right now.
 *
 * A PERSONAL scope has exactly one member. Requiring an administrator there did not
 * protect anyone — it meant a plain user could not register their own laptop at all,
 * and the fleet they were refused write access to was their own and empty. The scope
 * id IS the owner (`personal:<userId>`), so no ownership column is needed to say
 * whose machine it is.
 *
 * Reads are unchanged and were never admin-gated; so is the scope filter, which is
 * what keeps one person's machines out of everyone else's list.
 */
export function assertCanManageFleet(session: ScopedSession): void {
  if (isAdmin(session)) return;
  if (isPersonalScope(session)) return;
  throw new AppException("FLEET_ADMIN_REQUIRED", "Fleet administrator access is required", 403);
}

/**
 * The strongest MCP token this session may mint.
 *
 * ⚠ IT IS `assertCanManageFleet` EXPRESSED AS A CEILING, NOT A SECOND RULE. A fleet
 * token is a credential that acts as this person later and without a browser, so the
 * question "may they grant it the power to change the fleet" has to have the same
 * answer as "may they change the fleet". Writing the condition out a second time is
 * how the two come to disagree, and the disagreement would be a privilege-escalation
 * path: a member of an organization who cannot rename a host in the dashboard would
 * otherwise mint a token that can.
 *
 * A member who is not an administrator still gets a read-only token, which is the
 * useful part for them — "which of my machines is offline" needs no authority at all.
 */
export function mcpCeilingFor(session: ScopedSession): "read" | "admin" {
  if (isAdmin(session)) return "admin";
  if (isPersonalScope(session)) return "admin";
  return "read";
}
