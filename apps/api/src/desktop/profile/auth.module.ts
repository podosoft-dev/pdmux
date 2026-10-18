import { requireDesktopSession } from "./session-guard";
import { Elysia } from "elysia";
import { ACCESS_POLICY, DATABASE, REQUEST_GUARDS, REQUEST_IDENTITY, RESOLVED_SESSIONS, type PodokitModule, type ServiceKey } from "../../core/services";
import { AuthService, createRequestIdentity } from "../../auth/auth.service";
import { SettingsService } from "../../settings/settings.service";
import { authConfigStore } from "../../auth/auth-config-store";
import { authRuntime, primeAuth } from "../../auth/auth-provider";
import { configureAuthQueryDatabase } from "../../auth/db";
import { publishConfigChanged } from "../../auth/config-events";

export const AUTH = Symbol("auth") as ServiceKey<AuthService>;
export const SETTINGS = Symbol("settings") as ServiceKey<SettingsService>;
export const AUTH_CONFIG = Symbol("auth-config") as ServiceKey<unknown>;

export const authModule: PodokitModule = {
  name: "desktop-auth",
  configure: (_env, services): void => {
    const database = services.resolve(DATABASE);
    configureAuthQueryDatabase(database.sql);
    const policy = services.resolve(ACCESS_POLICY);
    const settings = new SettingsService(database.sql, authConfigStore, publishConfigChanged);
    const auth = new AuthService(settings, policy, { resolvedSessions: services.resolve(RESOLVED_SESSIONS) });
    services.register(SETTINGS, settings);
    services.register(AUTH, auth, () => auth.close());
    services.onStart(primeAuth);
    services.override(REQUEST_IDENTITY, createRequestIdentity(auth));
    policy.register("*", "/api/auth/*", "public");
    policy.register("GET", "/account/capabilities", "public");
    services.resolve(REQUEST_GUARDS).register(({ request }) => requireDesktopSession(auth, policy, request));
  },
  plugin: ({ services }) => new Elysia({ name: "desktop.auth" })
    .all("/api/auth/*", ({ request }) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/get-session" || path === "/api/auth/desktop-local/profiles" || path === "/api/auth/desktop-local/session") return authRuntime.handler(request);
      return new Response(null, { status: 404 });
    }, { parse: "none" })
    .get("/account/me", async ({ request }) => (await services.resolve(AUTH).requireSession(request)).user)
    .get("/account/require-2fa", () => ({ require2fa: false }))
    .get("/account/capabilities", async () => ({
      twoFactor: false, magicLink: false, emailOtp: false, username: false, multiSession: false,
      phoneNumber: false, apiKey: false, passkey: false, organization: false, oidcProvider: false,
      require2fa: false, providers: [], deleteAccount: false, emailVerification: false,
      signupApprovalRequired: false, passwordBreachCheck: false, auditLog: false,
      sessionIdleTimeoutMinutes: null, roles: ["user"],
      appFlags: { mcpEnabled: await services.resolve(SETTINGS).getBool("mcpEnabled") },
    })),
};
