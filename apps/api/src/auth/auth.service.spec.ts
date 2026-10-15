import { describe, expect, mock, test } from "bun:test";
import { AccessPolicy, type RequestIdentity } from "../core/services";
import type { SettingsService } from "../settings/settings.service";
import {
  AuthService,
  createRequestIdentity,
  rolesOf,
  type AuthSession,
  type SessionResolver,
} from "./auth.service";

function settings(require2fa: boolean): SettingsService {
  return { getBool: () => require2fa } as unknown as SettingsService;
}

function session(
  overrides: Partial<AuthSession["user"]> = {},
  sessionFields: Record<string, unknown> = {},
): AuthSession {
  return { user: { id: "user-1", ...overrides }, session: sessionFields };
}

function identityFor(resolver: SessionResolver): RequestIdentity {
  return createRequestIdentity(new AuthService(settings(false), new AccessPolicy(), resolver));
}

describe("AuthService", () => {
  test("normalizes string and array roles", () => {
    expect(rolesOf(session({ role: "user, admin" }).user)).toEqual(["user", "admin"]);
    expect(rolesOf(session({ role: ["owner"] }).user)).toEqual(["owner"]);
  });

  test("keeps explicitly public routes unauthenticated", async () => {
    const policy = new AccessPolicy();
    policy.register("GET", "/public", "public");
    const service = new AuthService(settings(false), policy, async () => null);
    await expect(service.guard(new Request("http://localhost/public"))).resolves.toBeUndefined();
  });

  test("requires a session by default", async () => {
    const service = new AuthService(settings(false), new AccessPolicy(), async () => null);
    const result = service.guard(new Request("http://localhost/private"));
    await expect(result).rejects.toMatchObject({ code: "AUTH_REQUIRED", statusCode: 401 });
  });

  test("requires two-factor enrolment when the policy is enabled", async () => {
    const service = new AuthService(
      settings(true),
      new AccessPolicy(),
      async () => session({ twoFactorEnabled: false }),
    );
    const result = service.guard(new Request("http://localhost/private"));
    await expect(result).rejects.toMatchObject({ code: "TWO_FACTOR_REQUIRED", statusCode: 403 });
  });

  test("requires the admin role for admin operations", async () => {
    const service = new AuthService(
      settings(false),
      new AccessPolicy(),
      async () => session({ role: "user" }),
    );
    await expect(service.requireAdmin(new Request("http://localhost/account/settings")))
      .rejects.toMatchObject({ code: "ADMIN_REQUIRED", statusCode: 403 });
  });
});

describe("createRequestIdentity", () => {
  const request = (): Request => new Request("http://localhost/events");

  test("treats a request without a session as anonymous", async () => {
    const identity = identityFor(async () => null);
    const anonymous = request();
    expect(await identity.userId(anonymous)).toBeUndefined();
    expect(await identity.isAdmin(anonymous)).toBe(false);
    expect(await identity.roles(anonymous)).toEqual([]);
    expect(await identity.activeOrganizationId(anonymous)).toBeUndefined();
  });

  test("reads every role from the comma-separated admin plugin format", async () => {
    const identity = identityFor(async () => session({ role: "user,admin" }));
    const signedIn = request();
    expect(await identity.userId(signedIn)).toBe("user-1");
    expect(await identity.roles(signedIn)).toEqual(["user", "admin"]);
    expect(await identity.isAdmin(signedIn)).toBe(true);
  });

  test("reads roles stored as an array", async () => {
    const identity = identityFor(async () => session({ role: ["moderator"] }));
    const signedIn = request();
    expect(await identity.roles(signedIn)).toEqual(["moderator"]);
    expect(await identity.isAdmin(signedIn)).toBe(false);
  });

  test("returns no roles when the user has none", async () => {
    const identity = identityFor(async () => session({ role: null }));
    expect(await identity.roles(request())).toEqual([]);
  });

  test("reads the active organization from the session", async () => {
    const active = identityFor(async () => session({}, { activeOrganizationId: "org-1" }));
    expect(await active.activeOrganizationId(request())).toBe("org-1");

    const cleared = identityFor(async () => session({}, { activeOrganizationId: null }));
    expect(await cleared.activeOrganizationId(request())).toBeUndefined();

    const missing = identityFor(async () => session());
    expect(await missing.activeOrganizationId(request())).toBeUndefined();
  });

  test("resolves the session once per request across all questions", async () => {
    const resolver = mock(async (_headers: Headers): Promise<AuthSession | null> =>
      session({ role: "admin" }, { activeOrganizationId: "org-1" }));
    const identity = identityFor(resolver);
    const first = request();

    await Promise.all([
      identity.userId(first),
      identity.isAdmin(first),
      identity.roles(first),
      identity.activeOrganizationId(first),
    ]);
    await identity.roles(first);
    expect(resolver).toHaveBeenCalledTimes(1);

    await identity.userId(request());
    expect(resolver).toHaveBeenCalledTimes(2);
  });
});
