import { describe, expect, it } from "bun:test";
import { AppException } from "@podosoft/podokit-contracts";
import { assertCanManageFleet, isAdmin, isPersonalScope, resolveScopeId, type ScopedSession } from "./session-scope";

const USER_ID = "user-1";

function session(overrides: { role?: string | string[] | null; org?: string | null } = {}): ScopedSession {
  return {
    user: { id: USER_ID, name: "Alice", email: "alice@example.com", role: overrides.role ?? "user" },
    session: { activeOrganizationId: overrides.org ?? null },
  };
}

describe("[TC-PDADMIN-020] who may change the fleet", () => {
  it("lets an administrator change an organization's fleet", () => {
    expect(() => assertCanManageFleet(session({ role: "admin", org: "org-a" }))).not.toThrow();
  });

  it("lets an administrator change their own personal fleet", () => {
    expect(() => assertCanManageFleet(session({ role: "admin" }))).not.toThrow();
  });

  /**
   * The reason this rule was widened. Before it, a plain user could not register their
   * own laptop at all — and the fleet they were refused write access to was their own,
   * and empty.
   */
  it("lets a member change their own personal fleet", () => {
    expect(() => assertCanManageFleet(session())).not.toThrow();
  });

  /** An organization's fleet is shared, so changing it stays an administrator's job. */
  it("refuses a member in an organization", () => {
    expect(() => assertCanManageFleet(session({ org: "org-a" }))).toThrow(AppException);
  });

  /** Roles arrive from better-auth as a comma-separated string. */
  it("reads admin out of a multi-role string", () => {
    expect(() => assertCanManageFleet(session({ role: "moderator,admin", org: "org-a" }))).not.toThrow();
    expect(() => assertCanManageFleet(session({ role: "moderator,user", org: "org-a" }))).toThrow(AppException);
  });

  /**
   * A session with no user has no personal scope to own, and must not fall through the
   * `isPersonalScope` branch just because `activeOrganizationId` is absent — that is
   * exactly the shape a request that slipped past the auth guard would have.
   */
  it("refuses a session without a user", () => {
    const anonymous: ScopedSession = { user: null, session: null };
    expect(() => resolveScopeId(anonymous)).toThrow(AppException);
    expect(() => assertCanManageFleet(anonymous)).toThrow(AppException);
  });
});

describe("scope resolution", () => {
  it("prefers the active organization and falls back to the user", () => {
    expect(resolveScopeId(session({ org: "org-a" }))).toBe("org-a");
    expect(resolveScopeId(session())).toBe(`personal:${USER_ID}`);
  });

  it("treats an empty organization id as no organization", () => {
    expect(resolveScopeId(session({ org: "" }))).toBe(`personal:${USER_ID}`);
    expect(isPersonalScope(session({ org: "" }))).toBe(true);
  });

  it("separates being an administrator from owning the scope", () => {
    expect(isAdmin(session({ role: "admin", org: "org-a" }))).toBe(true);
    expect(isPersonalScope(session({ role: "admin", org: "org-a" }))).toBe(false);
    expect(isAdmin(session())).toBe(false);
    expect(isPersonalScope(session())).toBe(true);
  });
});
