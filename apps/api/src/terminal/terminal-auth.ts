import { resolveScopeId, type ScopedSession } from "../fleet/session-scope";
import type { Host } from "../hosts/host.entity";

/** Who a terminal socket belongs to. Denormalized for the audit trail — a pane
 *  opened last month must stay readable after the user is renamed or deleted. */
export interface TerminalPrincipal {
  userId: string;
  userName: string | null;
  userEmail: string | null;
  scopeId: string;
}

export type TerminalAuthResult =
  | { ok: true; principal: TerminalPrincipal; host: Host }
  | { ok: false; status: number; reason: string };

export interface HostLookup {
  get(organizationId: string, id: string): Promise<Host>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decide whether a browser may open a terminal on a host.
 *
 * A terminal is remote command execution, so this is the tightest gate in the
 * system and it runs BEFORE the upgrade completes — an unauthorised caller never
 * gets a socket to send frames on.
 *
 * Cross-tenant answers **404, not 403**: the scoped lookup cannot find the host,
 * and saying "forbidden" would confirm that the id exists in someone else's
 * organization.
 */
export async function authorizeTerminal(params: {
  session: ScopedSession | null;
  hostId: string | null;
  hosts: HostLookup;
}): Promise<TerminalAuthResult> {
  const { session, hostId, hosts } = params;
  if (!session?.user?.id) return { ok: false, status: 401, reason: "authentication required" };
  if (!hostId || !UUID.test(hostId)) return { ok: false, status: 400, reason: "hostId required" };

  let scopeId: string;
  try {
    scopeId = resolveScopeId(session);
  } catch {
    return { ok: false, status: 403, reason: "no organization scope" };
  }

  try {
    const host = await hosts.get(scopeId, hostId);
    // A parked host has no agent to talk to; failing here beats a socket that
    // accepts input and answers nothing.
    if (!host.enabled) return { ok: false, status: 403, reason: "host disabled" };
    return {
      ok: true,
      host,
      principal: {
        userId: String(session.user.id),
        userName: session.user.name ?? null,
        userEmail: session.user.email ?? null,
        scopeId,
      },
    };
  } catch {
    return { ok: false, status: 404, reason: "host not found" };
  }
}
