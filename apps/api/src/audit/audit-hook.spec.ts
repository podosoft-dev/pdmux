import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { apiKey } from "@better-auth/api-key";
import { oauthProvider } from "@better-auth/oauth-provider";
import { envAuthConfig } from "@podosoft/podokit-auth";
import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { getAuthTables } from "better-auth/db";
import { admin, bearer, emailOTP, jwt, magicLink, multiSession, phoneNumber, twoFactor } from "better-auth/plugins";
import { buildAuth } from "../auth/auth";
import { setAuditRecorder, type AuditEntry } from "./audit-events";
import { auditPlugin, NOT_SIGN_INS, SIGN_IN_METHODS } from "./audit-hook";

const BASE_URL = "http://localhost:5002";
const PASSWORD = "Podokit3e-Str0ng!pw";

// The plugins PodoKit's auth.ts and modules configure. Endpoints of other
// plugins, such as one an application adds, are not classified below: the
// audit plugin records their sign-ins by default.
const PODOKIT_PLUGINS = new Set([
  "podokit-feature-gate",
  "podokit-revoke-every-other-session",
  "two-factor",
  "magic-link",
  "email-otp",
  "username",
  "multi-session",
  "phone-number",
  "api-key",
  "passkey",
  "organization",
  "bearer",
  "jwt",
  "oauth-provider",
  "open-api",
  "have-i-been-pwned",
  "admin",
  "podokit-audit",
]);

// Endpoints of Better Auth and of those plugins that never end with a session
// other than the one the request came with, which some of them set again. A
// Better Auth upgrade that adds an endpoint fails "classifies every endpoint"
// until the endpoint is added here, to SIGN_IN_METHODS, or to NOT_SIGN_INS.
const STARTS_NO_SESSION = new Set([
  "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration", "/account-info",
  "/admin/ban-user", "/admin/create-user", "/admin/get-user", "/admin/has-permission",
  "/admin/list-user-sessions", "/admin/list-users", "/admin/oauth2/create-client", "/admin/oauth2/resources",
  "/admin/oauth2/resources/:identifier", "/admin/oauth2/resources/:identifier/clients/:client_id",
  "/admin/oauth2/update-client", "/admin/remove-user", "/admin/revoke-user-session", "/admin/revoke-user-sessions",
  "/admin/set-role", "/admin/set-user-password", "/admin/unban-user", "/admin/update-user",
  "/api-key/create", "/api-key/delete", "/api-key/get", "/api-key/list", "/api-key/update",
  "/change-email", "/delete-user", "/delete-user/callback",
  "/email-otp/change-email", "/email-otp/check-verification-otp", "/email-otp/request-email-change",
  "/email-otp/request-password-reset", "/email-otp/reset-password", "/email-otp/send-verification-otp",
  "/error", "/forget-password/email-otp", "/get-access-token", "/get-session", "/is-username-available", "/jwks",
  "/link-social", "/list-accounts", "/list-sessions", "/multi-session/list-device-sessions",
  "/oauth2/authorize", "/oauth2/client/rotate-keys", "/oauth2/client/rotate-secret", "/oauth2/consent",
  "/oauth2/continue", "/oauth2/create-client", "/oauth2/delete-client", "/oauth2/delete-consent",
  "/oauth2/end-session", "/oauth2/end-session/confirm", "/oauth2/get-client", "/oauth2/get-clients",
  "/oauth2/get-consent", "/oauth2/get-consents", "/oauth2/introspect", "/oauth2/public-client",
  "/oauth2/public-client-prelogin", "/oauth2/register", "/oauth2/revoke", "/oauth2/token", "/oauth2/update-client",
  "/oauth2/update-consent", "/oauth2/userinfo", "/ok", "/open-api/generate-schema",
  "/organization/accept-invitation", "/organization/cancel-invitation", "/organization/check-slug",
  "/organization/create", "/organization/delete", "/organization/get-active-member",
  "/organization/get-active-member-role", "/organization/get-full-organization", "/organization/get-invitation",
  "/organization/get-organization", "/organization/has-permission", "/organization/invite-member",
  "/organization/leave", "/organization/list", "/organization/list-invitations", "/organization/list-members",
  "/organization/list-user-invitations", "/organization/reject-invitation", "/organization/remove-member",
  "/organization/set-active", "/organization/update", "/organization/update-member-role",
  "/passkey/delete-passkey", "/passkey/generate-authenticate-options", "/passkey/generate-register-options",
  "/passkey/list-user-passkeys", "/passkey/update-passkey", "/passkey/verify-registration",
  "/phone-number/request-password-reset", "/phone-number/reset-password", "/phone-number/send-otp",
  "/reference", "/refresh-token", "/request-password-reset", "/reset-password", "/reset-password/:token",
  "/revoke-other-sessions", "/revoke-session", "/revoke-sessions", "/send-verification-email",
  "/sign-in/magic-link", "/sign-out", "/token", "/two-factor/generate-backup-codes", "/two-factor/get-totp-uri",
  "/two-factor/send-otp", "/unlink-account", "/update-session", "/update-user", "/verify-password",
]);

interface Mailbox {
  magicLink: string;
  otp: string;
  verification: string;
  reset: string;
  sms: string;
  deletion: string;
}

interface AuthHandler {
  handler: (request: Request) => Promise<Response>;
}

let entries: AuditEntry[] = [];
let restoreRecorder = (): void => undefined;

beforeEach(() => {
  entries = [];
  restoreRecorder = setAuditRecorder({
    record: async (entry) => {
      entries.push(entry);
    },
    recordLater: (entry) => {
      entries.push(entry);
    },
  });
});

afterEach(() => restoreRecorder());

const logins = (): AuditEntry[] => entries.filter((entry) => entry.action === "auth.login");
const actions = (action: string): AuditEntry[] => entries.filter((entry) => entry.action === action);

// Like @better-auth/electron's /electron/token, which a desktop app calls with
// the code its browser sign-in handed over: an endpoint of an application's own
// plugin that starts a session for a user it looks up.
function desktopSignIn(): BetterAuthPlugin {
  return {
    id: "desktop-sign-in",
    endpoints: {
      desktopToken: createAuthEndpoint("/desktop/token", { method: "POST" }, async (ctx) => {
        const { code } = (ctx.body ?? {}) as { code?: string };
        const found = code ? await ctx.context.internalAdapter.findUserByEmail(code) : null;
        if (!found) throw new APIError("NOT_FOUND", { message: "Invalid or expired token." });
        const session = await ctx.context.internalAdapter.createSession(found.user.id);
        await setSessionCookie(ctx, { session, user: found.user });
        return ctx.json({ token: session.token });
      }),
    },
  };
}

interface StartOptions {
  enabled?: () => Promise<boolean>;
  session?: BetterAuthOptions["session"];
  /** Self-registered accounts wait for approval without a session, as auth.ts does. */
  signupApproval?: boolean;
  /** Whether an email verification link signs its user in. */
  verificationSignIn?: boolean;
  /** Lets users delete their own account, at once or through a mailed link. */
  accountDeletion?: "immediate" | "link";
}

// Like auth.ts with sign-up approval on: a self-registered account starts
// pending and gets no session until an administrator approves it.
const signupApprovalHooks: BetterAuthOptions["databaseHooks"] = {
  user: {
    create: {
      before: async (user, context) => ({ data: { ...user, signupApproved: context?.path === "/admin/create-user" } }),
    },
  },
  session: {
    create: {
      before: async (session, context) => {
        const user = (await context?.context.internalAdapter.findUserById(session.userId)) as { signupApproved?: boolean } | null;
        if (user?.signupApproved === false) throw new APIError("FORBIDDEN", { message: "Waiting for approval." });
      },
    },
  },
};

// The sign-in methods PodoKit's auth.ts enables and plugins that set or swap
// sessions without a sign-in, on an in-memory database, with the audit plugin
// pushed last as the audit-log module does.
function startAuth({
  enabled = async () => true,
  session,
  signupApproval = false,
  verificationSignIn = true,
  accountDeletion,
}: StartOptions = {}) {
  const mail: Mailbox = { magicLink: "", otp: "", verification: "", reset: "", sms: "", deletion: "" };
  const db: Record<string, Record<string, unknown>[]> = {};
  const options = {
    baseURL: BASE_URL,
    secret: "audit-hook-test-secret-0123456789abcdef",
    database: memoryAdapter(db),
    ...(session ? { session } : {}),
    ...(signupApproval ? { databaseHooks: signupApprovalHooks } : {}),
    user: {
      changeEmail: { enabled: true, updateEmailWithoutVerification: true },
      ...(accountDeletion
        ? {
            deleteUser: {
              enabled: true,
              ...(accountDeletion === "link"
                ? {
                    sendDeleteAccountVerification: async ({ token }: { token: string }) => {
                      mail.deletion = token;
                    },
                  }
                : {}),
            },
          }
        : {}),
      additionalFields: { signupApproved: { type: "boolean" as const, required: false, defaultValue: true, input: false } },
    },
    emailAndPassword: {
      enabled: true,
      autoSignIn: !signupApproval,
      sendResetPassword: async ({ token }: { token: string }) => {
        mail.reset = token;
      },
    },
    emailVerification: {
      autoSignInAfterVerification: verificationSignIn,
      sendVerificationEmail: async ({ url }: { url: string }) => {
        mail.verification = url;
      },
    },
    socialProviders: {
      google: {
        clientId: "client",
        clientSecret: "secret",
        getUserInfo: async () => ({
          user: { email: "social@example.com", name: "Social", emailVerified: true },
          data: {
            sub: "google-1",
            email: "social@example.com",
            email_verified: true,
            name: "Social",
            given_name: "Social",
            family_name: "User",
            picture: "https://example.com/social.png",
            aud: "client",
            azp: "client",
            iss: "https://accounts.google.com",
            iat: 0,
            exp: 0,
          },
        }),
      },
    },
    plugins: [
      twoFactor({ issuer: "podokit" }),
      magicLink({
        sendMagicLink: async ({ url }) => {
          mail.magicLink = url;
        },
      }),
      emailOTP({
        changeEmail: { enabled: true },
        sendVerificationOTP: async ({ otp }) => {
          mail.otp = otp;
        },
      }),
      phoneNumber({
        sendOTP: async ({ code }) => {
          mail.sms = code;
        },
        sendPasswordResetOTP: async ({ code }) => {
          mail.sms = code;
        },
      }),
      multiSession(),
      apiKey({ enableSessionForAPIKeys: true, rateLimit: { enabled: false } }),
      bearer({ requireSignature: true }),
      jwt({ disableSettingJwtHeader: true }),
      oauthProvider({ loginPage: "/login", consentPage: "/oauth2/consent" }),
      admin(),
      desktopSignIn(),
      auditPlugin({ enabled }),
    ],
  };
  for (const table of Object.values(getAuthTables(options))) db[table.modelName] = [];
  return { auth: betterAuth(options), mail, db };
}

// A cookie jar in front of the Better Auth router, like a browser's, or a client
// that sends the same headers with every request.
class Browser {
  private readonly auth: AuthHandler;
  private readonly sent: Record<string, string>;
  private readonly cookies = new Map<string, string>();

  constructor(auth: AuthHandler, sent: Record<string, string> = {}) {
    this.auth = auth;
    this.sent = sent;
  }

  /** Request headers that carry this browser's cookies, for a server-side auth.api call. */
  headers(): Headers {
    const headers = new Headers(this.sent);
    if (this.cookies.size > 0) headers.set("cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    return headers;
  }

  get(path: string): Promise<Response> {
    return this.send("GET", path);
  }

  post(path: string, body: unknown): Promise<Response> {
    return this.send("POST", path, body);
  }

  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    const headers = this.headers();
    headers.set("origin", BASE_URL);
    if (body !== undefined) headers.set("content-type", "application/json");
    const url = path.startsWith("http") ? path : `${BASE_URL}/api/auth${path}`;
    const response = await this.auth.handler(
      new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" }),
    );
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (/max-age=0/i.test(cookie) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }
}

async function signUp(auth: AuthHandler, email: string): Promise<Browser> {
  const browser = new Browser(auth);
  expect((await browser.post("/sign-up/email", { email, password: PASSWORD, name: "Audit" })).status).toBe(200);
  return browser;
}

async function userId(browser: Browser): Promise<string> {
  return ((await (await browser.get("/get-session")).json()) as { user: { id: string } }).user.id;
}

// The current code for an otpauth:// URI, as an authenticator app computes it.
function totp(uri: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const secret = (new URL(uri).searchParams.get("secret") ?? "").replace(/=+$/, "").toUpperCase();
  const bits = [...secret].map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

const otherCode = (code: string): string => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

// A Google sign-in through the provider's callback, with the token endpoint
// stubbed; the provider reports social@example.com, verified.
async function googleSignIn(browser: Browser): Promise<Response> {
  const realFetch = globalThis.fetch;
  const tokenEndpoint = spyOn(globalThis, "fetch").mockImplementation(((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Promise.resolve(Response.json({ access_token: "access", expires_in: 3600, token_type: "Bearer" }));
    }
    return realFetch(input, init);
  }) as typeof fetch);
  try {
    const started = await browser.post("/sign-in/social", { provider: "google", callbackURL: `${BASE_URL}/` });
    const state = new URL(((await started.json()) as { url: string }).url).searchParams.get("state") ?? "";
    return await browser.get(`/callback/google?code=code&state=${encodeURIComponent(state)}`);
  } finally {
    tokenEndpoint.mockRestore();
  }
}

async function makeAdmin(db: Record<string, Record<string, unknown>[]>, browser: Browser): Promise<string> {
  const id = await userId(browser);
  const row = db.user?.find((user) => user.id === id);
  if (row) row.role = "admin";
  return id;
}

describe("audit plugin", () => {
  test("records a password sign-in once and a wrong password not at all", async () => {
    const { auth } = startAuth();
    await signUp(auth, "password@example.com");
    // Signing up starts a session too, recorded as the sign-up only.
    expect(entries.map((entry) => entry.action)).toEqual(["auth.signup"]);

    const wrong = await new Browser(auth).post("/sign-in/email", { email: "password@example.com", password: "Wrong-password-1" });
    expect(wrong.status).toBe(401);
    expect(logins()).toEqual([]);

    const right = await new Browser(auth).post("/sign-in/email", { email: "password@example.com", password: PASSWORD });
    expect(right.status).toBe(200);
    expect(logins()).toEqual([
      expect.objectContaining({
        actorEmail: "password@example.com",
        targetLabel: "password@example.com",
        metadata: { method: "password" },
      }),
    ]);
  });

  test("records a Google sign-in with its provider and not a callback with a forged state", async () => {
    const { auth } = startAuth();
    const realFetch = globalThis.fetch;
    const tokenEndpoint = spyOn(globalThis, "fetch").mockImplementation(((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return Promise.resolve(Response.json({ access_token: "access", expires_in: 3600, token_type: "Bearer" }));
      }
      return realFetch(input, init);
    }) as typeof fetch);
    try {
      const browser = new Browser(auth);
      const started = await browser.post("/sign-in/social", { provider: "google", callbackURL: `${BASE_URL}/` });
      const state = new URL(((await started.json()) as { url: string }).url).searchParams.get("state") ?? "";
      expect(logins()).toEqual([]);

      const forged = await new Browser(auth).get("/callback/google?code=code&state=forged");
      expect(forged.status).toBe(302);
      expect(logins()).toEqual([]);

      const callback = await browser.get(`/callback/google?code=code&state=${encodeURIComponent(state)}`);
      expect(callback.status).toBe(302);
      expect(logins()).toEqual([
        expect.objectContaining({ actorEmail: "social@example.com", metadata: { method: "social", provider: "google" } }),
      ]);
    } finally {
      tokenEndpoint.mockRestore();
    }
  });

  test("records magic link and email code sign-ins, and not a used link or a wrong code", async () => {
    const { auth, mail } = startAuth();
    const browser = new Browser(auth);
    await browser.post("/sign-in/magic-link", { email: "magic@example.com", callbackURL: `${BASE_URL}/` });
    expect(logins()).toEqual([]);
    expect((await browser.get(mail.magicLink)).status).toBe(302);
    expect((await new Browser(auth).get(mail.magicLink)).status).toBe(302);
    expect(logins()).toEqual([expect.objectContaining({ actorEmail: "magic@example.com", metadata: { method: "magic-link" } })]);

    entries = [];
    const coded = new Browser(auth);
    await coded.post("/email-otp/send-verification-otp", { email: "code@example.com", type: "sign-in" });
    const wrong = await coded.post("/sign-in/email-otp", { email: "code@example.com", otp: otherCode(mail.otp) });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(logins()).toEqual([]);
    expect((await coded.post("/sign-in/email-otp", { email: "code@example.com", otp: mail.otp })).status).toBe(200);
    expect(logins()).toEqual([expect.objectContaining({ actorEmail: "code@example.com", metadata: { method: "email-otp" } })]);
  });

  test("records a two-factor sign-in when the second factor completes it", async () => {
    const { auth } = startAuth();
    const email = "two-factor@example.com";
    const owner = await signUp(auth, email);
    const enabled = (await (await owner.post("/two-factor/enable", { password: PASSWORD })).json()) as {
      totpURI: string;
      backupCodes: string[];
    };
    // Confirming the authenticator replaces the owner's session; nobody signs in.
    expect((await owner.post("/two-factor/verify-totp", { code: totp(enabled.totpURI) })).status).toBe(200);
    expect(actions("2fa.enable")).toHaveLength(1);
    expect(logins()).toEqual([]);

    const challenged = new Browser(auth);
    const pending = await challenged.post("/sign-in/email", { email, password: PASSWORD });
    expect(await pending.json()).toMatchObject({ twoFactorRedirect: true });
    expect(logins()).toEqual([]);
    const code = totp(enabled.totpURI);
    expect((await challenged.post("/two-factor/verify-totp", { code: otherCode(code) })).status).toBe(401);
    expect(logins()).toEqual([]);
    expect((await challenged.post("/two-factor/verify-totp", { code })).status).toBe(200);
    expect(logins()).toEqual([expect.objectContaining({ actorEmail: email, metadata: { method: "two-factor-totp" } })]);

    const backup = new Browser(auth);
    await backup.post("/sign-in/email", { email, password: PASSWORD });
    expect((await backup.post("/two-factor/verify-backup-code", { code: enabled.backupCodes[0] })).status).toBe(200);
    expect(logins().map((entry) => entry.metadata)).toEqual([
      { method: "two-factor-totp" },
      { method: "two-factor-backup-code" },
    ]);
  });

  test("records an email verification link as a sign-in only when it starts a session", async () => {
    const { auth, mail } = startAuth();
    const owner = await signUp(auth, "verified@example.com");
    await owner.post("/send-verification-email", { email: "verified@example.com", callbackURL: `${BASE_URL}/` });
    expect((await owner.get(mail.verification)).status).toBe(302);
    expect(actions("auth.email_verified")).toHaveLength(1);
    expect(logins()).toEqual([]);

    const sender = await signUp(auth, "elsewhere@example.com");
    await sender.post("/send-verification-email", { email: "elsewhere@example.com", callbackURL: `${BASE_URL}/` });
    expect((await new Browser(auth).get(mail.verification)).status).toBe(302);
    expect(actions("auth.email_verified")).toHaveLength(2);
    expect(logins()).toEqual([
      expect.objectContaining({ actorEmail: "elsewhere@example.com", metadata: { method: "email-verification" } }),
    ]);

    const forged = await new Browser(auth).get(`/verify-email?token=forged&callbackURL=${encodeURIComponent(`${BASE_URL}/`)}`);
    expect(forged.status).toBe(302);
    expect(new URL(forged.headers.get("location") ?? "", BASE_URL).searchParams.get("error")).toBeTruthy();
    expect(actions("auth.email_verified")).toHaveLength(2);
    expect(logins()).toHaveLength(1);
  });

  test("records a sign-in that resumes an OAuth authorization request", async () => {
    const { auth } = startAuth();
    const owner = await signUp(auth, "oauth@example.com");
    const client = await auth.api.adminCreateOAuthClient({
      headers: owner.headers(),
      body: { redirect_uris: ["https://client.example.com/callback"], skip_consent: true },
    });
    const verifier = "audit-hook-code-verifier-0123456789abcdefghijklmnop";
    const query = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://client.example.com/callback",
      scope: "openid",
      state: "state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });

    const browser = new Browser(auth);
    const authorize = await browser.get(`/oauth2/authorize?${query}`);
    expect(authorize.status).toBe(302);
    const login = new URL(authorize.headers.get("location") ?? "", BASE_URL);
    const signedIn = await browser.post("/sign-in/email", {
      email: "oauth@example.com",
      password: PASSWORD,
      oauth_query: login.search.slice(1),
    });
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toMatchObject({ redirect: true, url: expect.stringContaining("code=") });
    expect(logins()).toEqual([expect.objectContaining({ actorEmail: "oauth@example.com", metadata: { method: "password" } })]);

    // Authorizing again with that session and exchanging the code sign nobody in.
    const again = await browser.get(`/oauth2/authorize?${query}`);
    expect(again.status).toBe(302);
    const code = new URL(again.headers.get("location") ?? "").searchParams.get("code") ?? "";
    expect(code).not.toBe("");
    const exchange = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://client.example.com/callback",
      code_verifier: verifier,
    });
    const credentials = Buffer.from(`${client.client_id}:${client.client_secret ?? ""}`).toString("base64");
    const token = await auth.handler(
      new Request(`${BASE_URL}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${credentials}` },
        body: exchange,
      }),
    );
    expect(token.status).toBe(200);
    expect(logins()).toHaveLength(1);
  });

  test("does not record failed account and admin requests", async () => {
    const { auth } = startAuth();
    const target = await signUp(auth, "target@example.com");
    const targetId = ((await (await target.get("/get-session")).json()) as { user: { id: string } }).user.id;
    const member = await signUp(auth, "member@example.com");

    expect((await member.post("/admin/ban-user", { userId: targetId })).status).toBe(403);
    expect(actions("user.ban")).toEqual([]);

    const wrong = await member.post("/change-password", { currentPassword: "Wrong-password-1", newPassword: "N3w-Str0ng!password" });
    expect(wrong.status).toBe(400);
    expect(actions("auth.password_change")).toEqual([]);

    const changed = await member.post("/change-password", {
      currentPassword: PASSWORD,
      newPassword: "N3w-Str0ng!password",
      revokeOtherSessions: true,
    });
    expect(changed.status).toBe(200);
    expect(actions("auth.password_change")).toEqual([expect.objectContaining({ actorEmail: "member@example.com" })]);
    expect(logins()).toEqual([]);
  });

  test("records a sign-in through an endpoint of an application's plugin with its path", async () => {
    const { auth } = startAuth();
    await signUp(auth, "desktop@example.com");
    entries = [];

    const desktop = new Browser(auth);
    expect((await desktop.post("/desktop/token", { code: "nobody@example.com" })).status).toBe(404);
    expect(logins()).toEqual([]);
    expect((await desktop.post("/desktop/token", { code: "desktop@example.com" })).status).toBe(200);
    expect(logins()).toEqual([
      expect.objectContaining({ actorEmail: "desktop@example.com", metadata: { method: "/desktop/token" } }),
    ]);
    // The session it started is then the desktop app's own.
    expect((await desktop.get("/get-session")).status).toBe(200);
    expect((await desktop.post("/update-user", { name: "Desktop" })).status).toBe(200);
    expect(logins()).toHaveLength(1);
  });

  test("records no sign-in for reads and updates that refresh the session", async () => {
    // Every session read extends the session and the cookie cache expires at once.
    const { auth } = startAuth({ session: { updateAge: 0, cookieCache: { enabled: true, maxAge: 1 } } });
    const owner = await signUp(auth, "refresh@example.com");
    entries = [];
    expect((await owner.get("/get-session")).status).toBe(200);
    expect((await owner.get("/get-session?disableCookieCache=true")).status).toBe(200);
    expect((await owner.post("/update-user", { name: "Refreshed" })).status).toBe(200);
    expect((await owner.post("/change-email", { newEmail: "refreshed@example.com" })).status).toBe(200);
    expect((await owner.post("/update-session", {})).status).toBeLessThan(500);
    expect((await owner.get("/token")).status).toBe(200);
    expect((await owner.get("/list-sessions")).status).toBe(200);
    expect(actions("account.update")).toHaveLength(1);
    expect(actions("auth.email_change")).toHaveLength(1);
    expect(logins()).toEqual([]);
  });

  test("records no sign-in for bearer and API key requests", async () => {
    const { auth } = startAuth({ session: { updateAge: 0 } });
    const owner = await signUp(auth, "client@example.com");
    const signIn = await new Browser(auth).post("/sign-in/email", { email: "client@example.com", password: PASSWORD });
    const token = signIn.headers.get("set-auth-token") ?? "";
    expect(token).not.toBe("");
    const created = await owner.post("/api-key/create", {});
    expect(created.status).toBe(200);
    const { key } = (await created.json()) as { key: string };
    entries = [];

    for (const client of [new Browser(auth, { authorization: `Bearer ${token}` }), new Browser(auth, { "x-api-key": key })]) {
      for (let i = 0; i < 3; i++) expect((await client.get("/get-session")).status).toBe(200);
      expect((await client.post("/update-user", { name: "Client" })).status).toBe(200);
      expect((await client.get("/list-sessions")).status).toBe(200);
    }
    expect(actions("account.update")).toHaveLength(2);
    expect(logins()).toEqual([]);
  });

  test("records no sign-in when an administrator impersonates a user or a browser switches accounts", async () => {
    const { auth, db } = startAuth();
    const operator = await signUp(auth, "operator@example.com");
    const operatorId = await userId(operator);
    const row = db.user?.find((user) => user.id === operatorId);
    if (row) row.role = "admin";
    const target = await signUp(auth, "impersonated@example.com");
    const targetId = await userId(target);
    entries = [];

    expect((await operator.post("/admin/impersonate-user", { userId: targetId })).status).toBe(200);
    expect(await userId(operator)).toBe(targetId);
    expect((await operator.post("/admin/stop-impersonating", {})).status).toBe(200);
    expect(await userId(operator)).toBe(operatorId);
    expect(actions("user.impersonate")).toHaveLength(1);
    expect(actions("user.stop_impersonate")).toHaveLength(1);
    expect(logins()).toEqual([]);

    // Signing in to a second account in the same browser is a sign-in; switching
    // between the two and signing one out are not.
    const second = await operator.post("/sign-in/email", { email: "impersonated@example.com", password: PASSWORD });
    expect(second.status).toBe(200);
    expect(logins()).toEqual([expect.objectContaining({ actorEmail: "impersonated@example.com" })]);
    const sessions = (await (await operator.get("/multi-session/list-device-sessions")).json()) as Array<{
      session: { token: string };
      user: { id: string };
    }>;
    const tokenOf = (id: string): string => sessions.find((entry) => entry.user.id === id)?.session.token ?? "";
    expect((await operator.post("/multi-session/set-active", { sessionToken: tokenOf(operatorId) })).status).toBe(200);
    expect(await userId(operator)).toBe(operatorId);
    expect((await operator.post("/multi-session/revoke", { sessionToken: tokenOf(operatorId) })).status).toBe(200);
    expect(await userId(operator)).toBe(targetId);
    expect((await operator.post("/revoke-other-sessions", {})).status).toBe(200);
    expect((await operator.post("/revoke-sessions", {})).status).toBe(200);
    expect(logins()).toHaveLength(1);

    const again = await new Browser(auth).post("/sign-in/email", { email: "operator@example.com", password: PASSWORD });
    expect(again.status).toBe(200);
    const signedOut = new Browser(auth);
    await signedOut.post("/sign-in/email", { email: "operator@example.com", password: PASSWORD });
    expect((await signedOut.post("/sign-out", {})).status).toBe(200);
    expect(actions("auth.logout")).toHaveLength(1);
    expect(logins()).toHaveLength(3);
  });

  test("records nothing while auditing is off", async () => {
    const { auth } = startAuth({ enabled: async () => false });
    await signUp(auth, "off@example.com");
    expect((await new Browser(auth).post("/sign-in/email", { email: "off@example.com", password: PASSWORD })).status).toBe(200);
    expect(entries).toEqual([]);
  });
});

describe("audit plugin accounts and sessions", () => {
  test("records an email sign-up once, and not a duplicate answered as if it succeeded", async () => {
    const { auth } = startAuth({ signupApproval: true });
    const first = await new Browser(auth).post("/sign-up/email", { email: "pending@example.com", password: PASSWORD, name: "P" });
    expect(first.status).toBe(200);
    const id = (await first.json()) as { user: { id: string } };
    // With auto sign-in off, Better Auth answers a taken address with the same 200.
    const again = await new Browser(auth).post("/sign-up/email", { email: "pending@example.com", password: PASSWORD, name: "P" });
    expect(again.status).toBe(200);
    expect(entries).toEqual([
      expect.objectContaining({
        action: "auth.signup",
        actorEmail: "pending@example.com",
        targetId: id.user.id,
        targetLabel: "pending@example.com",
        metadata: { method: "password" },
      }),
    ]);
  });

  test("records a social sign-up that waits for approval, without a sign-in", async () => {
    const { auth, db } = startAuth({ signupApproval: true });
    // The approval hook refuses the session, so the callback fails after the
    // account is stored.
    expect((await googleSignIn(new Browser(auth))).status).toBe(403);
    expect(db.session).toEqual([]);
    expect(db.user).toHaveLength(1);
    expect(entries).toEqual([
      expect.objectContaining({
        action: "auth.signup",
        actorEmail: "social@example.com",
        targetId: db.user?.[0]?.id,
        metadata: { method: "social", provider: "google" },
      }),
    ]);
  });

  test("records an approved social sign-up and its sign-in, and a later sign-in alone", async () => {
    const { auth } = startAuth();
    expect((await googleSignIn(new Browser(auth))).status).toBe(302);
    expect(entries.map((entry) => [entry.action, entry.metadata])).toEqual([
      ["auth.signup", { method: "social", provider: "google" }],
      ["auth.login", { method: "social", provider: "google" }],
    ]);
    expect((await googleSignIn(new Browser(auth))).status).toBe(302);
    expect(entries.map((entry) => entry.action)).toEqual(["auth.signup", "auth.login", "auth.login"]);
  });

  test("records the account a magic link or an email code creates as a sign-up", async () => {
    const { auth, mail } = startAuth();
    const linked = new Browser(auth);
    await linked.post("/sign-in/magic-link", { email: "new-magic@example.com", callbackURL: `${BASE_URL}/` });
    expect((await linked.get(mail.magicLink)).status).toBe(302);
    const coded = new Browser(auth);
    await coded.post("/email-otp/send-verification-otp", { email: "new-code@example.com", type: "sign-in" });
    expect((await coded.post("/sign-in/email-otp", { email: "new-code@example.com", otp: mail.otp })).status).toBe(200);
    expect(entries.map((entry) => [entry.action, entry.actorEmail, entry.metadata])).toEqual([
      ["auth.signup", "new-magic@example.com", { method: "magic-link" }],
      ["auth.login", "new-magic@example.com", { method: "magic-link" }],
      ["auth.signup", "new-code@example.com", { method: "email-otp" }],
      ["auth.login", "new-code@example.com", { method: "email-otp" }],
    ]);
  });

  test("records an administrator's new user as user.create only, with its id", async () => {
    const { auth, db } = startAuth({ signupApproval: true });
    await new Browser(auth).post("/sign-up/email", { email: "creator@example.com", password: PASSWORD, name: "C" });
    const creator = db.user?.[0];
    if (creator) Object.assign(creator, { role: "admin", signupApproved: true });
    const operator = new Browser(auth);
    expect((await operator.post("/sign-in/email", { email: "creator@example.com", password: PASSWORD })).status).toBe(200);
    entries = [];

    const created = await operator.post("/admin/create-user", { email: "made@example.com", password: PASSWORD, name: "M" });
    expect(created.status).toBe(200);
    const { user } = (await created.json()) as { user: { id: string } };
    expect(entries).toEqual([
      expect.objectContaining({ action: "user.create", actorEmail: "creator@example.com", targetId: user.id, targetLabel: "made@example.com" }),
    ]);
  });

  test("records an account created outside a request without an actor", async () => {
    const { auth } = startAuth();
    const context = await auth.$context;
    const user = await context.internalAdapter.createUser(
      { email: "seeded@example.com", name: "Seeded", emailVerified: true },
      { method: "seed" },
    );
    expect(entries).toEqual([
      { action: "auth.signup", targetId: user.id, targetLabel: "seeded@example.com", ip: null },
    ]);
  });

  test("names the user who signs out, and records nothing for a sign-out without a session", async () => {
    const { auth } = startAuth();
    const owner = await signUp(auth, "leaving@example.com");
    const id = await userId(owner);
    entries = [];
    expect((await new Browser(auth).post("/sign-out", {})).status).toBe(200);
    const forged = new Browser(auth, { cookie: "better-auth.session_token=forged.signature" });
    expect((await forged.post("/sign-out", {})).status).toBe(200);
    expect(entries).toEqual([]);

    expect((await owner.post("/sign-out", {})).status).toBe(200);
    expect(entries).toEqual([
      expect.objectContaining({ action: "auth.logout", actorId: id, actorEmail: "leaving@example.com", targetId: id }),
    ]);
    // The session is gone, so signing out again ends nothing.
    expect((await owner.post("/sign-out", {})).status).toBe(200);
    expect(actions("auth.logout")).toHaveLength(1);
  });

  test("records a sign-out of every account a browser holds", async () => {
    const { auth } = startAuth();
    await signUp(auth, "first@example.com");
    await signUp(auth, "second@example.com");
    const browser = new Browser(auth);
    await browser.post("/sign-in/email", { email: "first@example.com", password: PASSWORD });
    await browser.post("/sign-in/email", { email: "second@example.com", password: PASSWORD });
    entries = [];
    expect((await browser.post("/sign-out", {})).status).toBe(200);
    expect(actions("auth.logout").map((entry) => entry.actorEmail).sort()).toEqual(["first@example.com", "second@example.com"]);
  });

  test("names the owner of a session an administrator revokes, and the administrator who stops impersonating", async () => {
    const { auth, db } = startAuth();
    const operator = await signUp(auth, "revoker@example.com");
    await makeAdmin(db, operator);
    const target = await signUp(auth, "revoked@example.com");
    const targetId = await userId(target);
    const { session } = (await (await target.get("/get-session")).json()) as { session: { token: string } };
    entries = [];

    expect((await operator.post("/admin/revoke-user-session", { sessionToken: session.token })).status).toBe(200);
    expect(actions("user.session_revoke")).toEqual([
      expect.objectContaining({ actorEmail: "revoker@example.com", targetId, targetLabel: "revoked@example.com" }),
    ]);

    expect((await operator.post("/admin/impersonate-user", { userId: targetId })).status).toBe(200);
    expect((await operator.post("/admin/stop-impersonating", {})).status).toBe(200);
    expect(actions("user.stop_impersonate")).toEqual([
      expect.objectContaining({ actorEmail: "revoker@example.com", targetId, targetLabel: "revoked@example.com" }),
    ]);
    // Ending the impersonation session is not a sign-out.
    expect(actions("auth.logout")).toEqual([]);
  });

  test("names the user an administrator removes by the email it had", async () => {
    const { auth, db } = startAuth();
    const operator = await signUp(auth, "remover@example.com");
    await makeAdmin(db, operator);
    const target = await signUp(auth, "removed@example.com");
    const targetId = await userId(target);
    entries = [];

    expect((await operator.post("/admin/remove-user", { userId: "missing" })).status).toBe(404);
    expect((await operator.post("/admin/remove-user", { userId: targetId })).status).toBe(200);
    expect(db.user?.some((user) => user.id === targetId)).toBe(false);
    expect(entries).toEqual([
      expect.objectContaining({
        action: "user.delete",
        actorEmail: "remover@example.com",
        targetId,
        targetLabel: "removed@example.com",
      }),
    ]);
  });

  test("names the account a user deletes", async () => {
    const { auth, db } = startAuth({ accountDeletion: "immediate" });
    const owner = await signUp(auth, "deleting@example.com");
    const id = await userId(owner);
    entries = [];

    expect((await owner.post("/delete-user", { password: "Wrong-password-1" })).status).toBe(400);
    expect((await owner.post("/delete-user", { password: PASSWORD })).status).toBe(200);
    expect(db.user).toEqual([]);
    expect(entries).toEqual([
      expect.objectContaining({
        action: "account.delete",
        actorId: id,
        actorEmail: "deleting@example.com",
        targetId: id,
        targetLabel: "deleting@example.com",
      }),
    ]);
  });

  test("records an account deletion confirmed by link when the link deletes it", async () => {
    const { auth, db, mail } = startAuth({ accountDeletion: "link" });
    const owner = await signUp(auth, "confirming@example.com");
    const id = await userId(owner);
    const other = await signUp(auth, "confirming-in-app@example.com");
    const otherId = await userId(other);
    entries = [];

    // Asking only mails the link, and the link needs its user's session.
    expect((await owner.post("/delete-user", {})).status).toBe(200);
    expect(db.user).toHaveLength(2);
    expect(entries).toEqual([]);
    expect((await new Browser(auth).get(`/delete-user/callback?token=${mail.deletion}`)).status).toBeGreaterThanOrEqual(400);
    expect(entries).toEqual([]);
    expect((await owner.get(`/delete-user/callback?token=${mail.deletion}`)).status).toBe(200);

    // The token can also come back in the body of a second /delete-user.
    expect((await other.post("/delete-user", {})).status).toBe(200);
    expect((await other.post("/delete-user", { token: mail.deletion })).status).toBe(200);
    expect(db.user).toEqual([]);
    expect(entries).toEqual([
      expect.objectContaining({
        action: "account.delete",
        actorId: id,
        actorEmail: "confirming@example.com",
        targetId: id,
        targetLabel: "confirming@example.com",
      }),
      expect.objectContaining({
        action: "account.delete",
        actorId: otherId,
        actorEmail: "confirming-in-app@example.com",
        targetId: otherId,
        targetLabel: "confirming-in-app@example.com",
      }),
    ]);
  });

  test("names the user a password reset link, email code, or text message code resets", async () => {
    const { auth, mail, db } = startAuth();
    await signUp(auth, "reset@example.com");
    const id = db.user?.[0]?.id;
    entries = [];

    const anonymous = new Browser(auth);
    await anonymous.post("/request-password-reset", { email: "reset@example.com" });
    const wrong = await anonymous.post("/reset-password", { token: "forged", newPassword: "N3w-Str0ng!password" });
    expect(wrong.status).toBe(400);
    expect((await anonymous.post("/reset-password", { token: mail.reset, newPassword: "N3w-Str0ng!password" })).status).toBe(200);

    await anonymous.post("/email-otp/request-password-reset", { email: "reset@example.com" });
    const coded = await anonymous.post("/email-otp/reset-password", { email: "reset@example.com", otp: mail.otp, password: PASSWORD });
    expect(coded.status).toBe(200);

    const row = db.user?.[0];
    if (row) Object.assign(row, { phoneNumber: "+15550100", phoneNumberVerified: true });
    await anonymous.post("/phone-number/request-password-reset", { phoneNumber: "+15550100" });
    const texted = await anonymous.post("/phone-number/reset-password", {
      phoneNumber: "+15550100",
      otp: mail.sms,
      newPassword: "Th1rd-Str0ng!password",
    });
    expect(texted.status).toBe(200);

    expect(actions("auth.password_reset")).toEqual([
      expect.objectContaining({ actorId: id, actorEmail: "reset@example.com", targetId: id, targetLabel: "reset@example.com" }),
      expect.objectContaining({ actorId: id, actorEmail: "reset@example.com", targetId: id, targetLabel: "reset@example.com" }),
      expect.objectContaining({ actorId: id, actorEmail: "reset@example.com", targetId: id, targetLabel: "reset@example.com" }),
    ]);
  });

  test("names the user an email verification link or code verifies", async () => {
    const { auth, mail } = startAuth({ verificationSignIn: false });
    const owner = await signUp(auth, "verify-me@example.com");
    const id = await userId(owner);
    await owner.post("/send-verification-email", { email: "verify-me@example.com", callbackURL: `${BASE_URL}/` });
    expect((await new Browser(auth).get(mail.verification)).status).toBe(302);

    const coded = await signUp(auth, "verify-code@example.com");
    const codedId = await userId(coded);
    const anonymous = new Browser(auth);
    await anonymous.post("/email-otp/send-verification-otp", { email: "verify-code@example.com", type: "email-verification" });
    expect((await anonymous.post("/email-otp/verify-email", { email: "verify-code@example.com", otp: mail.otp })).status).toBe(200);

    expect(actions("auth.email_verified")).toEqual([
      expect.objectContaining({ actorId: id, actorEmail: "verify-me@example.com", targetId: id, targetLabel: "verify-me@example.com" }),
      expect.objectContaining({ actorId: codedId, targetId: codedId, targetLabel: "verify-code@example.com" }),
    ]);
  });

  test("records an email change by code", async () => {
    const { auth, mail } = startAuth();
    const owner = await signUp(auth, "old-address@example.com");
    expect((await owner.post("/email-otp/request-email-change", { newEmail: "new-address@example.com" })).status).toBe(200);
    expect((await owner.post("/email-otp/change-email", { newEmail: "new-address@example.com", otp: mail.otp })).status).toBe(200);
    expect(actions("auth.email_change")).toEqual([expect.objectContaining({ actorEmail: "old-address@example.com" })]);
  });
});

describe("the app's Better Auth", () => {
  test("runs the audit hook after every plugin's after hooks", () => {
    const instance = buildAuth(envAuthConfig());
    const plugins = instance.options.plugins as Array<{ id: string }>;
    expect(plugins.at(-1)?.id).toBe("podokit-audit");
    expect(instance.options.hooks?.after).toBeUndefined();
  });

  test("classifies every endpoint of Better Auth and PodoKit's plugins", () => {
    const instance = buildAuth(envAuthConfig());
    type Endpoints = Record<string, { path?: string }> | undefined;
    const pathsOf = (endpoints: Endpoints): string[] =>
      Object.values(endpoints ?? {}).flatMap((endpoint) => (endpoint.path ? [endpoint.path] : []));
    const plugins = instance.options.plugins as Array<{ id: string; endpoints?: Endpoints }>;
    const applications = new Set(
      plugins.filter((plugin) => !PODOKIT_PLUGINS.has(plugin.id)).flatMap((plugin) => pathsOf(plugin.endpoints)),
    );
    const paths = new Set(pathsOf(instance.api as Endpoints).filter((path) => !applications.has(path)));
    expect(Object.keys(SIGN_IN_METHODS).filter((path) => !paths.has(path))).toEqual([]);
    const classified = (path: string): boolean =>
      SIGN_IN_METHODS[path] !== undefined || NOT_SIGN_INS.has(path) || STARTS_NO_SESSION.has(path);
    expect([...paths].filter((path) => !classified(path))).toEqual([]);
  });
});
