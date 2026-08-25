import type { Capabilities } from "@podosoft/podokit-contracts";
import { Elysia, t } from "elysia";
import {
  ACCESS_POLICY,
  DATABASE,
  OPENAPI,
  REQUEST_GUARDS,
  REQUEST_IDENTITY,
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
import { generateAuthOpenApiDocument } from "./auth.openapi";
import { ROLE_NAMES } from "./permissions";
import { AuthService } from "./auth.service";

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
    .get("/account/require-2fa", () => ({ require2fa: settings.getBool("require2fa") }), {
      detail: { tags: ["account"], summary: "Get the two-factor enrolment policy" },
    })
    .get("/account/mcp-enabled", () => ({ mcpEnabled: settings.getBool("mcpEnabled") }), {
      detail: { tags: ["account"], summary: "Get the MCP server policy" },
    })
    .get("/account/capabilities", async (): Promise<Capabilities> => {
      const flags = settings.flags();
      const snapshot = await authConfigStore.capabilitiesSnapshot();
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
    const accessPolicy = services.resolve(ACCESS_POLICY);
    const settings = new SettingsService(database.sql);
    const authService = new AuthService(settings, accessPolicy);
    services.register(SETTINGS, settings);
    services.register(AUTH_CONFIG, new AuthConfigService(database.sql));
    services.register(AUTH, authService, () => authService.close());
    services.onStart(async () => {
      await settings.refresh();
      await primeAuth();
    });
    services.override(REQUEST_IDENTITY, {
      userId: async (request) => (await authService.session(request))?.user.id,
    });
    accessPolicy.register("*", "/api/auth", "public");
    accessPolicy.register("*", "/api/auth/*", "public");
    accessPolicy.register("GET", "/account/capabilities", "public");
    services.resolve(OPENAPI).register("better-auth", async () => {
      await primeAuth();
      const document = await generateAuthOpenApiDocument(getAuth().api);
      return {
        document,
        pathPrefix: "/api/auth",
      };
    });
    services.resolve(REQUEST_GUARDS).register(({ request }) => authService.guard(request));
  },
  plugin: accountPlugin,
};
