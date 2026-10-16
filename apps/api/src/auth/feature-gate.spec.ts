import { describe, expect, test } from "bun:test";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins";
import { FLAG_DEFAULTS, flagsFrom } from "../settings/flag-defaults";
import {
  authRequestPath,
  enforceFeatureGate,
  featureForPath,
  featureGatePlugin,
  PUBLIC_SIGNUP_DISABLED,
  signupOpenFrom,
  type FeatureFlags,
  type FeatureGateSettings,
} from "./feature-gate";

function settings(flags: Partial<FeatureFlags>, signupOpen = true): FeatureGateSettings {
  return {
    flags: async () => ({ ...FLAG_DEFAULTS, ...flags }),
    signupOpen: async () => signupOpen,
  };
}

const failing: FeatureGateSettings = {
  flags: async () => {
    throw new Error('relation "app_setting" does not exist');
  },
  signupOpen: async () => {
    throw new Error('relation "app_setting" does not exist');
  },
};

describe("feature gate", () => {
  test("rejects a disabled feature's endpoints with 404", async () => {
    await expect(enforceFeatureGate("/sign-in/magic-link", settings({ magicLink: false })))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(enforceFeatureGate("/sign-in/magic-link", settings({ magicLink: true })))
      .resolves.toBeUndefined();
    await expect(enforceFeatureGate("/get-session", settings({ magicLink: false })))
      .resolves.toBeUndefined();
  });

  test("closes public sign-up without blocking other paths", async () => {
    await expect(enforceFeatureGate("/sign-up/email", settings({}, false)))
      .rejects.toMatchObject({ body: { code: PUBLIC_SIGNUP_DISABLED } });
    await expect(enforceFeatureGate("/sign-in/social", settings({}, false)))
      .resolves.toBeUndefined();
  });

  test("fails open to defaults when the settings cannot be read", async () => {
    await expect(enforceFeatureGate("/sign-up/email", failing)).resolves.toBeUndefined();
    await expect(enforceFeatureGate("/sign-in/magic-link", failing)).resolves.toBeUndefined();
    await expect(enforceFeatureGate("/phone-number/send-otp", failing))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  test("projects stored settings over the shipped defaults", () => {
    const stored = new Map([["magicLink", "false"], ["phoneNumber", "true"], ["site.allowSignup", "false"]]);
    expect(flagsFrom(stored)).toMatchObject({ magicLink: false, phoneNumber: true, twoFactor: true });
    expect(flagsFrom(new Map())).toEqual(FLAG_DEFAULTS);
    expect(signupOpenFrom(stored)).toBe(false);
    expect(signupOpenFrom(new Map())).toBe(true);
  });
});

describe("OIDC provider gate", () => {
  test("covers the provider's endpoints but not the jwt plugin's", () => {
    for (const path of [
      "/oauth2/authorize",
      "/oauth2/token",
      "/oauth2/userinfo",
      "/oauth2/register",
      "/oauth2/consent",
      "/oauth2/create-client",
      "/oauth2/end-session",
      "/admin/oauth2/create-client",
      "/.well-known/openid-configuration",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/api/auth",
    ]) {
      expect(featureForPath(path)).toBe("oidcProvider");
    }
    for (const path of ["/jwks", "/token", "/get-session", "/sign-in/email"]) {
      expect(featureForPath(path)).toBeUndefined();
    }
  });

  test("resolves request paths against the auth base URL", () => {
    const base = "http://localhost:5002/api/auth";
    expect(authRequestPath("http://localhost:5002/api/auth/oauth2/authorize?client_id=x", base))
      .toBe("/oauth2/authorize");
    expect(authRequestPath("http://localhost:5002/api/auth/.well-known/openid-configuration", `${base}/`))
      .toBe("/.well-known/openid-configuration");
    expect(authRequestPath("http://localhost:5002/.well-known/oauth-authorization-server/api/auth", base))
      .toBe("/.well-known/oauth-authorization-server/api/auth");
    expect(authRequestPath("http://localhost:5002/api/authority/oauth2/token", base))
      .toBe("/api/authority/oauth2/token");
  });

  test("answers the provider's discovery with 404 while it is disabled and serves it once enabled", async () => {
    let enabled = false;
    const auth = betterAuth({
      database: memoryAdapter({ jwks: [] }),
      baseURL: "http://localhost:5002",
      secret: "feature-gate-spec-secret-0123456789abcdef",
      logger: { disabled: true },
      plugins: [
        featureGatePlugin({
          flags: async () => ({ ...FLAG_DEFAULTS, oidcProvider: enabled }),
          signupOpen: async () => true,
        }),
        jwt(),
        // Serves the discovery metadata from its own onRequest hook.
        oauthProvider({ loginPage: "/login", consentPage: "/oauth2/consent" }),
      ],
    });
    const request = (path: string): Promise<Response> =>
      auth.handler(new Request(`http://localhost:5002${path}`));
    const discovery = [
      "/api/auth/.well-known/openid-configuration",
      "/api/auth/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/api/auth",
    ];

    for (const path of discovery) {
      const response = await request(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ message: "This feature is disabled." });
    }
    expect((await request("/api/auth/oauth2/authorize?client_id=probe")).status).toBe(404);
    expect((await request("/api/auth/jwks")).status).toBe(200);

    enabled = true;
    for (const path of discovery) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect((await response.json()).issuer).toBe("http://localhost:5002/api/auth");
    }
  });
});
