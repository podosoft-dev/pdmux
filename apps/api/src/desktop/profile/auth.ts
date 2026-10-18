import { betterAuth, type BetterAuthOptions } from "better-auth";
import type { AuthConfig } from "@podosoft/podokit-auth";
import { envAuthConfig } from "@podosoft/podokit-auth";
import { AUTH_CONFIG_DEFAULTS } from "../../auth/auth-config-store";
import { authBaseUrl, authSecret } from "../../auth/auth-environment";
import { authDatabase } from "../../auth/db";
import { isMaintenanceCommand } from "../../auth/maintenance";
import { desktopLocalAuth } from "../local-auth";

// Only the native capability can create a local session. Server authentication,
// administration, mail delivery and organization plugins are not in this build.
function desktopOptions(): BetterAuthOptions {
  return {
    appName: "PDMux", database: authDatabase,
    secret: authSecret(), baseURL: authBaseUrl(),
    trustedOrigins: (process.env.CORS_ORIGIN ?? "").split(",").filter(Boolean),
    emailAndPassword: { enabled: false },
    plugins: [desktopLocalAuth()],
    advanced: isMaintenanceCommand() ? { database: { validateSchema: false } } : {},
    user: { additionalFields: {
      role: { type: "string", defaultValue: "user", input: false },
      signupApproved: { type: "boolean", defaultValue: true, input: false },
    } },
  };
}

export function buildAuth(_config: AuthConfig): ReturnType<typeof betterAuth> {
  return betterAuth(desktopOptions());
}

export const auth = buildAuth(envAuthConfig(AUTH_CONFIG_DEFAULTS));
