import { electron } from "@better-auth/electron";
import { desktopAuthOptions } from "../desktop/auth-options";
import { desktopLocalAuth, isDesktopOwnerCreation } from "../desktop/local-auth";
import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { twoFactor, haveIBeenPwned, magicLink, emailOTP, username, multiSession, phoneNumber, organization, jwt, bearer, openAPI } from "better-auth/plugins";
import { actionEmail, sendMail } from "../mail/mailer";
import { sendSms } from "../sms/sms";
import { assertUserCreationAllowed, createFeatureGate, featureGatePlugin, readSignupOpen, type FeatureGateSettings } from "./feature-gate";
import { AUTH_CONFIG_DEFAULTS, featureFlags, isSignupOpen } from "./auth-config-store";
import { orgAc, orgRoles } from "./org-permissions";
import { authDatabase } from "./db";
import { type AuthConfig, envAuthConfig, sessionIdleOptions, SUPPORTED_PROVIDER_IDS } from "@podosoft/podokit-auth";
import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { oauthProvider } from "@better-auth/oauth-provider";
import { SIGNUP_APPROVAL_REQUIRED } from "@podosoft/podokit-contracts";
import { runUserDeletedHandlers } from "./user-delete-handlers";
import { authBaseUrl, authSecret } from "./auth-environment";
import { isMaintenanceCommand } from "./maintenance";
import { CLIENT_ADDRESS_HEADER } from "../core/client-address";
import { revokeEveryOtherSession } from "./revoke-other-sessions";
// podokit:begin:auth-imports
import { admin } from "better-auth/plugins";
import { ac, roles } from "./permissions";
import { auditAfterHook } from "../audit/audit-hook";
// podokit:end:auth-imports

// Web origin(s) where the browser runs (WebAuthn ceremonies must match these).
const webOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5001").split(",").map((o) => o.trim());

const adminEmails = new Set(
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);

// Enabled social providers, from the resolved config (DB-first, env fallback).
// Admins add/edit/remove providers dynamically (Settings page), so this maps the
// whole config.social record. Secrets arrive already decrypted; a provider needs
// enabled + id + secret, and must be a better-auth-supported provider id (the
// allowlist guards betterAuth() from an unknown key). The provider option shape
// (clientId/clientSecret/redirectURI) is common to every supported provider.
function buildSocial(config: AuthConfig): NonNullable<BetterAuthOptions["socialProviders"]> {
  const providers: Record<string, { clientId: string; clientSecret: string; redirectURI?: string }> = {};
  for (const [id, p] of Object.entries(config.social)) {
    if (!SUPPORTED_PROVIDER_IDS.has(id) || !p.enabled || !p.clientId || !p.clientSecret) continue;
    providers[id] = { clientId: p.clientId, clientSecret: p.clientSecret, ...(p.redirectURI ? { redirectURI: p.redirectURI } : {}) };
  }
  return providers as NonNullable<BetterAuthOptions["socialProviders"]>;
}

// Build a better-auth instance from resolved config. Called at boot and rebuilt by
// auth-provider.ts when the DB config changes, so admin edits (OAuth credentials,
// server-enforced toggles) apply without a restart. Everything below the injection
// markers is contributed by other PodoKit modules (admin-dashboard, audit-log).
export function buildAuth(config: AuthConfig) {
  // The feature gate reads the process-wide settings snapshot, so a rebuild does
  // not start a new cache.
  const gateSettings: FeatureGateSettings = { flags: featureFlags, signupOpen: isSignupOpen };
  const plugins: BetterAuthPlugin[] = [
    // First, so a disabled feature answers 404 before another plugin's onRequest
    // (such as the OIDC provider's discovery metadata) can answer.
    featureGatePlugin(gateSettings),
    // "Sign out other sessions" revokes every other session, not only the first 100.
    revokeEveryOtherSession(),
    desktopLocalAuth(),
    electron({ clientID: "pdmux-desktop" }),
    // The issuer is the account name authenticator apps show.
    twoFactor({ issuer: config.appName }),
    magicLink({
      sendMagicLink: async ({ email, url }: { email: string; url: string; token: string }) => {
        await sendMail({
          to: email,
          subject: "Your sign-in link",
          text: `Sign in: ${url}`,
          html: actionEmail("Sign in to your account", "Click the button below to sign in. This link expires shortly.", url, "Sign in"),
        });
      },
    }),
    emailOTP({
      sendVerificationOTP: async ({ email, otp }: { email: string; otp: string; type: string }) => {
        await sendMail({
          to: email,
          subject: "Your sign-in code",
          text: `Your one-time code is ${otp}. It expires shortly.`,
          html: `<p>Your one-time sign-in code is:</p><p style="font-size:24px;font-weight:bold;letter-spacing:3px">${otp}</p><p>It expires shortly.</p>`,
        });
      },
    }),
    // Adds username/displayUsername columns; lets users sign in with a username.
    username(),
    // Let one browser hold several signed-in accounts and switch between them.
    multiSession(),
    // Phone-number sign-in/verification. SMS delivery is a dev stub (logs the code);
    // wire a real provider in sendOTP for production.
    phoneNumber({
      sendOTP: async ({ phoneNumber: to, code }: { phoneNumber: string; code: string }) => {
        await sendSms({ to, body: `Your verification code is ${code}` });
      },
    }),
    // User-issued API keys (DB-backed). Distinct from the static X-API-Key module.
    apiKey(),
    // Passwordless sign-in with WebAuthn passkeys. The ceremony runs at the web
    // origin, so expected origins are the CORS origins and rpID is their host.
    // rpName is the name the browser shows in the passkey prompt.
    passkey({ rpName: config.appName, rpID: new URL(webOrigins[0]).hostname, origin: webOrigins }),
    // Multi-tenant organizations: teams with members, roles, and email invitations.
    organization({
      // Custom member roles (adds "manager") and a parent-organization link so orgs
      // can form a hierarchy. See org-permissions.ts.
      ac: orgAc,
      roles: orgRoles,
      schema: { organization: { additionalFields: { parentOrganizationId: { type: "string", required: false, input: true } } } },
      sendInvitationEmail: async (data: { email: string; id: string; organization: { name: string }; inviter: { user: { name: string; email: string } } }) => {
        const url = `${webOrigins[0]}/accept-invitation/${data.id}`;
        await sendMail({
          to: data.email,
          subject: `You are invited to ${data.organization.name}`,
          text: `${data.inviter.user.name} invited you to ${data.organization.name}. Accept: ${url}`,
          html: actionEmail(
            `Join ${data.organization.name}`,
            `${data.inviter.user.name} (${data.inviter.user.email}) invited you to join ${data.organization.name}.`,
            url,
            "Accept invitation",
          ),
        });
      },
    }),
    // Accept the session token via `Authorization: Bearer <token>` (returned in the
    // `set-auth-token` response header on sign-in) instead of a cookie — for API and
    // mobile clients. Infrastructure plugin (always on), like jwt(); no UI toggle.
    // requireSignature ignores unsigned values, so API keys and OAuth access tokens
    // sent as bearer credentials never cost a session lookup that cannot match.
    bearer({ requireSignature: true }),
    // JWT/JWKS signing keys — required by the OAuth provider to sign id_tokens.
    // Without disableSettingJwtHeader, every session lookup (including server-side
    // getSession calls) signs an unused `set-auth-jwt` header. Clients that need a
    // JWT call GET /api/auth/token.
    jwt({ disableSettingJwtHeader: true }),
    // Act as an OAuth2/OIDC identity provider: other apps can "Sign in with this app".
    // Register clients at /api/auth/oauth2/create-client; discovery at
    // /api/auth/.well-known/openid-configuration. See docs/modules.md.
    oauthProvider({ loginPage: "/login", consentPage: "/oauth2/consent" }),
    // Makes the dynamic Better Auth route contract available for the generated
    // OpenAPI parity check in addition to the Elysia application schema.
    openAPI(),
  ];
  // Reject passwords found in known breaches (Have I Been Pwned, k-anonymity range
  // API). Admin-toggleable (auth_config), applied live on the next request.
  if (config.hibp) {
    plugins.push(haveIBeenPwned());
  }
  // podokit:begin:auth-plugins
  plugins.push(admin({ defaultRole: "user", adminRoles: ["admin"], ac, roles }));
  // podokit:end:auth-plugins

  const databaseHooks: NonNullable<BetterAuthOptions["databaseHooks"]> = {
    user: {
      create: {
        before: async (user, context) => {
          if (isDesktopOwnerCreation()) return { data: { ...user, role: "admin", signupApproved: true, emailVerified: true } };
          const adminEmail = adminEmails.has(user.email.toLowerCase());
          const createdByAdmin = context?.path === "/admin/create-user";
          assertUserCreationAllowed(await readSignupOpen(isSignupOpen), context?.path);
          return {
            data: {
              ...user,
              // The admin plugin contributes `role` before this hook. Preserve an
              // explicitly requested admin-created role, while bootstrap emails
              // always become administrators.
              ...(Object.prototype.hasOwnProperty.call(user, "role")
                ? { role: adminEmail ? "admin" : user.role }
                : {}),
              // Existing rows are treated as approved through the field default.
              // Only self-registration while the policy is enabled starts pending.
              signupApproved: adminEmail || createdByAdmin || !config.requireSignupApproval,
            },
          };
        },
      },
    },
    session: {
      create: {
        before: async (session, context) => {
          if (!context) return;
          const user = (await context.context.internalAdapter.findUserById(session.userId)) as {
            signupApproved?: boolean | null;
          } | null;
          if (user?.signupApproved === false) {
            throw APIError.from("FORBIDDEN", {
              code: SIGNUP_APPROVAL_REQUIRED,
              message: "Your account is waiting for administrator approval.",
            });
          }
        },
      },
    },
  };

  // Request-time hooks. The feature gate turns the admin Settings toggles into a
  // real server boundary (disabled features 404) for endpoint calls, including
  // in-process auth.api calls the plugin above never sees. Other PodoKit modules
  // add their own hooks below the marker.
  const hooks: NonNullable<BetterAuthOptions["hooks"]> = {
    before: createFeatureGate(gateSettings),
  };
  // podokit:begin:auth-hooks
  hooks.after = auditAfterHook;
  // podokit:end:auth-hooks

  const session = sessionIdleOptions(config.sessionIdleTimeoutMinutes);

  return betterAuth(desktopAuthOptions({
    appName: config.appName,
    database: authDatabase,
    emailAndPassword: {
      enabled: true,
      // Pending email/password registrations should complete without creating a
      // session. All later sign-in methods are enforced by the session hook below.
      autoSignIn: !config.requireSignupApproval,
      requireEmailVerification: config.requireEmailVerification,
      sendResetPassword: async ({ user, url }) => {
        await sendMail({
          to: user.email,
          subject: "Reset your password",
          text: `Reset your password: ${url}`,
          html: actionEmail("Reset your password", "Click the button below to choose a new password.", url, "Reset password"),
        });
      },
      // podokit:begin:auth-email-password
      // podokit:end:auth-email-password
    },
    emailVerification: {
      sendOnSignUp: config.requireEmailVerification,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendMail({
          to: user.email,
          subject: "Verify your email",
          text: `Verify your email: ${url}`,
          html: actionEmail("Verify your email", "Confirm your address to finish setting up your account.", url, "Verify email"),
        });
      },
    },
    socialProviders: buildSocial(config),
    ...(session ? { session } : {}),
    plugins,
    hooks,
    secret: authSecret(),
    baseURL: authBaseUrl(),
    advanced: {
      ipAddress: {
        // The address the API resolved behind its trusted proxies, which it sets
        // on every request, so sessions and Better Auth's own rate limits use the
        // same client address as the rest of the API.
        ipAddressHeaders: [CLIENT_ADDRESS_HEADER],
      },
      ...(isMaintenanceCommand() ? { database: { validateSchema: false } } : {}),
    },
    user: {
      additionalFields: {
        signupApproved: {
          type: "boolean",
          required: false,
          defaultValue: true,
          input: false,
        },
      },
      // Self-service email change. When email verification is on, better-auth sends
      // an approval link to the current address before switching; otherwise it
      // changes immediately.
      changeEmail: {
        enabled: true,
        sendChangeEmailVerification: async ({
          user,
          newEmail,
          url,
        }: {
          user: { email: string };
          newEmail: string;
          url: string;
        }) => {
          await sendMail({
            to: user.email,
            subject: "Approve your email change",
            text: `Approve changing your email to ${newEmail}: ${url}`,
            html: actionEmail(
              "Approve email change",
              `Confirm changing your email address to ${newEmail}.`,
              url,
              "Approve change",
            ),
          });
        },
      },
      // Self-service account deletion — admin-toggleable (auth_config), applied live.
      deleteUser: {
        enabled: config.allowDelete,
        afterDelete: runUserDeletedHandlers,
      },
    },
    databaseHooks,
    // podokit:begin:auth-options
    trustedOrigins: (process.env.CORS_ORIGIN ?? "http://localhost:5001").split(",").map((origin) => origin.trim()),
    // podokit:end:auth-options
  }));
}

// Bootstrap instance from environment config. Used by the better-auth CLI
// (`--config auth.ts`) and as the guaranteed last-good fallback. The runtime
// mount (auth-provider.ts) rebuilds from DB config on top of this.
export const auth = buildAuth(envAuthConfig(AUTH_CONFIG_DEFAULTS));
