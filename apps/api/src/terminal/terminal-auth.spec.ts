import { describe, expect, it } from "@jest/globals";
import { AppException } from "../common/app-exception";
import type { ScopedSession } from "../fleet/session-scope";
import type { Host } from "../hosts/host.entity";
import { authorizeTerminal, type HostLookup } from "./terminal-auth";

const HOST_ID = "11111111-1111-4111-8111-111111111111";

function host(overrides: Partial<Host> = {}): Host {
  return { id: HOST_ID, organizationId: "org-a", label: "build-01", enabled: true, ...overrides } as Host;
}

/** Only returns the host when the scope matches — the same rule `GET /hosts/:id` uses. */
function hosts(scoped: Record<string, Host>): HostLookup {
  return {
    get: async (organizationId: string, id: string): Promise<Host> => {
      const found = scoped[`${organizationId}:${id}`];
      if (!found) throw new AppException("HOST_NOT_FOUND", "Host not found", 404);
      return found;
    },
  };
}

const lookup = hosts({ [`org-a:${HOST_ID}`]: host() });

describe("[TC-PDTERM-050] terminal upgrade authorisation", () => {
  const session: ScopedSession = {
    user: { id: "user-1", name: "Alice", email: "alice@example.com" },
    session: { activeOrganizationId: "org-a" },
  };

  it("admits a member of the host's organization", async () => {
    const result = await authorizeTerminal({ session, hostId: HOST_ID, hosts: lookup });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.host.id).toBe(HOST_ID);
    expect(result.principal).toEqual({
      userId: "user-1",
      userName: "Alice",
      userEmail: "alice@example.com",
      scopeId: "org-a",
    });
  });

  it("rejects an anonymous upgrade before any socket exists", async () => {
    expect(await authorizeTerminal({ session: null, hostId: HOST_ID, hosts: lookup })).toEqual({
      ok: false,
      status: 401,
      reason: "authentication required",
    });
    expect(await authorizeTerminal({ session: { user: {} }, hostId: HOST_ID, hosts: lookup })).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("answers 404 — never 403 — for another organization's host", async () => {
    const outsider: ScopedSession = { user: { id: "user-2" }, session: { activeOrganizationId: "org-b" } };
    // 403 would confirm that this host id exists somewhere else.
    expect(await authorizeTerminal({ session: outsider, hostId: HOST_ID, hosts: lookup })).toEqual({
      ok: false,
      status: 404,
      reason: "host not found",
    });
  });

  it("requires a well-formed hostId", async () => {
    expect(await authorizeTerminal({ session, hostId: null, hosts: lookup })).toMatchObject({ status: 400 });
    expect(await authorizeTerminal({ session, hostId: "../../etc", hosts: lookup })).toMatchObject({ status: 400 });
  });

  it("refuses a parked host instead of opening a socket nothing answers", async () => {
    const disabled = hosts({ [`org-a:${HOST_ID}`]: host({ enabled: false }) });
    expect(await authorizeTerminal({ session, hostId: HOST_ID, hosts: disabled })).toEqual({
      ok: false,
      status: 403,
      reason: "host disabled",
    });
  });

  it("scopes a user with no organization to their personal scope", async () => {
    const solo: ScopedSession = { user: { id: "user-3" } };
    const personal = hosts({ [`personal:user-3:${HOST_ID}`]: host({ organizationId: "personal:user-3" }) });
    const result = await authorizeTerminal({ session: solo, hostId: HOST_ID, hosts: personal });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.principal.scopeId).toBe("personal:user-3");
  });
});
