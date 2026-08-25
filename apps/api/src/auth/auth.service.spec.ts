import { describe, expect, test } from "bun:test";
import { AccessPolicy } from "../core/services";
import type { SettingsService } from "../settings/settings.service";
import { AuthService, rolesOf, type AuthSession } from "./auth.service";

function settings(require2fa: boolean): SettingsService {
  return { getBool: () => require2fa } as unknown as SettingsService;
}

function session(overrides: Partial<AuthSession["user"]> = {}): AuthSession {
  return { user: { id: "user-1", ...overrides }, session: {} };
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
