import type { Capabilities } from "@podosoft/podokit-contracts";
import { Elysia, t } from "elysia";
import { EVENTS } from "@podosoft/podokit-runtime";
import {
  ACCESS_POLICY,
  DATABASE,
  LOGGER,
  OPENAPI,
  REQUEST_GUARDS,
  REQUEST_IDENTITY,
  RESOLVED_SESSIONS,
  type AppPlugin,
  type PodokitModule,
  type ServiceKey,
} from "../core/services";
import {
  AuthConfigService,
  type AuthConfigUpdate,
} from "../auth-config/auth-config.service";
import { FEATURE_FLAGS, SettingsService, type FeatureFlag } from "../settings/settings.service";
import { authConfigStore } from "./auth-config-store";
import { getAuth, authRuntime, primeAuth } from "./auth-provider";
import { cachedAuthOpenApiDocuments } from "./auth.openapi";
import { ROLE_NAMES } from "./permissions";
import { AuthService, createRequestIdentity } from "./auth.service";
import { configureAuthQueryDatabase } from "./db";
import { configEvents, publishConfigChanged } from "./config-events";
import { setMailConfigStore } from "../mail/mailer";

export const AUTH = Symbol("auth") as ServiceKey<AuthService>;
export const SETTINGS = Symbol("settings") as ServiceKey<SettingsService>;
export const AUTH_CONFIG = Symbol("auth-config") as ServiceKey<AuthConfigService>;

const providerUpdateSchema = t.Object({
  enabled: t.Optional(t.Boolean()),
  clientId: t.Optional(t.String()),
  clientSecret: t.Optional(t.String()),
  redirectURI: t.Optional(t.String()),
  delete: t.Optional(t.Boolean()),
});

const authConfigUpdateSchema = t.Object({
  social: t.Optional(t.Record(t.String(), providerUpdateSchema)),
  smtp: t.Optional(t.Object({
    enabled: t.Optional(t.Boolean()),
    host: t.Optional(t.String()),
    port: t.Optional(t.Number()),
    secure: t.Optional(t.Boolean()),
    user: t.Optional(t.String()),
    pass: t.Optional(t.String()),
    from: t.Optional(t.String()),
  })),
  server: t.Optional(t.Object({
    requireEmailVerification: t.Optional(t.Boolean()),
    requireSignupApproval: t.Optional(t.Boolean()),
    allowDelete: t.Optional(t.Boolean()),
    hibp: t.Optional(t.Boolean()),
    auditLog: t.Optional(t.Boolean()),
    sessionIdleTimeoutMinutes: t.Optional(t.Nullable(t.Number())),
  })),
});

const accountPlugin: AppPlugin = ({ services }) => {
  const authService = services.resolve(AUTH);
  const settings = services.resolve(SETTINGS);
  const authConfig = services.resolve(AUTH_CONFIG);

  return new Elysia({ name: "podokit.auth" })
    .mount(authRuntime.handler)
    .get("/account/me", async ({ request }) => {
      const session = await authService.requireSession(request);
      return session.user;
    }, {
      detail: { tags: ["account"], summary: "Get the current account" },
    })
    .get("/account/require-2fa", async () => ({ require2fa: await settings.getBool("require2fa") }), {
      detail: { tags: ["account"], summary: "Get the two-factor enrolment policy" },
    })
    .get("/account/mcp-enabled", async () => ({ mcpEnabled: await settings.getBool("mcpEnabled") }), {
      detail: { tags: ["account"], summary: "Get the MCP server policy" },
    })
    .get("/account/capabilities", async (): Promise<Capabilities> => {
      const [flags, snapshot] = await Promise.all([
        settings.flags(),
        authConfigStore.capabilitiesSnapshot(),
      ]);
      return {
        twoFactor: flags.twoFactor,
        magicLink: flags.magicLink,
        emailOtp: flags.emailOtp,
        username: flags.username,
        multiSession: flags.multiSession,
        phoneNumber: flags.phoneNumber,
        apiKey: flags.apiKey,
        passkey: flags.passkey,
        organization: flags.organization,
        oidcProvider: flags.oidcProvider,
        require2fa: flags.require2fa,
        providers: snapshot.providers,
        deleteAccount: snapshot.allowDelete,
        emailVerification: snapshot.requireEmailVerification,
        signupApprovalRequired: snapshot.requireSignupApproval,
        passwordBreachCheck: snapshot.passwordBreachCheck,
        auditLog: snapshot.auditLog,
        sessionIdleTimeoutMinutes: snapshot.sessionIdleTimeoutMinutes,
        roles: ROLE_NAMES,
      };
    }, {
      detail: { tags: ["account"], summary: "Get authentication capabilities" },
    })
    .put("/account/settings", async ({ request, body }) => {
      await authService.requireAdmin(request);
      const update: Partial<Record<FeatureFlag, boolean>> = {};
      for (const flag of FEATURE_FLAGS) {
        const value = body[flag];
        if (typeof value === "boolean") update[flag] = value;
      }
      return settings.setMany(update);
    }, {
      body: t.Record(t.String(), t.Boolean()),
      detail: { tags: ["account"], summary: "Update authentication feature flags" },
    })
    .get("/account/auth-config", async ({ request }) => {
      await authService.requireAdmin(request);
      return authConfig.describe();
    }, {
      detail: { tags: ["account"], summary: "Get authentication configuration" },
    })
    .put("/account/auth-config", async ({ request, body }) => {
      await authService.requireAdmin(request);
      return authConfig.update(body as AuthConfigUpdate);
    }, {
      body: authConfigUpdateSchema,
      detail: { tags: ["account"], summary: "Update authentication configuration" },
    })
    .post("/account/org-member", async ({ request, body, set }) => {
      await authService.requireSession(request);
      const api = getAuth().api as unknown as {
        addMember: (options: {
          body: { organizationId: string; userId: string; role: string };
          headers: Headers;
        }) => Promise<unknown>;
      };
      const result = await api.addMember({ body, headers: request.headers });
      set.status = 201;
      return result;
    }, {
      body: t.Object({
        organizationId: t.String({ minLength: 1 }),
        userId: t.String({ minLength: 1 }),
        role: t.String({ minLength: 1 }),
      }),
      detail: { tags: ["account"], summary: "Add an organization member" },
    });
};

export const authModule: PodokitModule = {
  name: "auth",
  configure: (_env, services): void => {
    const database = services.resolve(DATABASE);
    configureAuthQueryDatabase(database.sql);
    setMailConfigStore(authConfigStore);
    const accessPolicy = services.resolve(ACCESS_POLICY);
    const settings = new SettingsService(database.sql, authConfigStore, publishConfigChanged);
    const authService = new AuthService(settings, accessPolicy, {
      resolvedSessions: services.resolve(RESOLVED_SESSIONS),
    });
    services.register(SETTINGS, settings);
    services.register(AUTH_CONFIG, new AuthConfigService(database.sql, database.provider));
    services.register(AUTH, authService, () => authService.close());
    services.onStart(async () => {
      await primeAuth();
      // Optional: with an events provider, other replicas' settings writes apply
      // at once instead of at the next version probe.
      const events = services.tryResolve(EVENTS);
      if (!events) return;
      try {
        await configEvents.listen(events, () => authConfigStore.invalidate());
      } catch (error) {
        services.resolve(LOGGER).warn(
          { reason: error instanceof Error ? error.message : String(error) },
          "Settings change events are unavailable; replicas converge on the settings TTL",
        );
      }
    });
    services.override(REQUEST_IDENTITY, createRequestIdentity(authService));
    accessPolicy.register("*", "/api/auth", "public");
    accessPolicy.register("*", "/api/auth/*", "public");
    accessPolicy.register("GET", "/account/capabilities", "public");
    const authOpenApiDocument = cachedAuthOpenApiDocuments();
    services.resolve(OPENAPI).register("better-auth", async () => {
      await primeAuth();
      return {
        document: await authOpenApiDocument(getAuth()),
        pathPrefix: "/api/auth",
      };
    });
    services.resolve(REQUEST_GUARDS).register(({ request }) => authService.guard(request));
  },
  plugin: accountPlugin,
};
