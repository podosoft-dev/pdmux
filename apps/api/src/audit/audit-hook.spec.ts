import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { oauthProvider } from "@better-auth/oauth-provider";
import { envAuthConfig } from "@podosoft/podokit-auth";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getAuthTables } from "better-auth/db";
import { admin, emailOTP, jwt, magicLink, twoFactor } from "better-auth/plugins";
import { buildAuth } from "../auth/auth";
import { setAuditRecorder, type AuditEntry } from "./audit-events";
import { auditPlugin, SIGN_IN_METHODS } from "./audit-hook";

const BASE_URL = "http://localhost:5002";
const PASSWORD = "Podokit3e-Str0ng!pw";

// Endpoints that look like a sign-in but never start a session of their own.
const STARTS_NO_SESSION = new Set([
  "/sign-in/magic-link", // emails the link that /magic-link/verify signs in with
  "/passkey/verify-registration", // adds a passkey for the signed-in user
  "/verify-password", // checks the signed-in user's password again
  "/delete-user/callback", // confirms an account deletion
  "/email-otp/check-verification-otp", // checks a code without using it
]);

interface Mailbox {
  magicLink: string;
  otp: string;
  verification: string;
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

// The sign-in methods PodoKit's auth.ts enables, on an in-memory database, with
// the audit plugin pushed last as the audit-log module does.
function startAuth(enabled: () => Promise<boolean> = async () => true) {
  const mail: Mailbox = { magicLink: "", otp: "", verification: "" };
  const db: Record<string, Record<string, unknown>[]> = {};
  const options = {
    baseURL: BASE_URL,
    secret: "audit-hook-test-secret-0123456789abcdef",
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    emailVerification: {
      autoSignInAfterVerification: true,
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
        sendVerificationOTP: async ({ otp }) => {
          mail.otp = otp;
        },
      }),
      jwt({ disableSettingJwtHeader: true }),
      oauthProvider({ loginPage: "/login", consentPage: "/oauth2/consent" }),
      admin(),
      auditPlugin({ enabled }),
    ],
  };
  for (const table of Object.values(getAuthTables(options))) db[table.modelName] = [];
  return { auth: betterAuth(options), mail };
}

// A cookie jar in front of the Better Auth router, like a browser's.
class Browser {
  private readonly auth: AuthHandler;
  private readonly cookies = new Map<string, string>();

  constructor(auth: AuthHandler) {
    this.auth = auth;
  }

  /** Request headers that carry this browser's cookies, for a server-side auth.api call. */
  headers(): Headers {
    return new Headers({ cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ") });
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

describe("audit plugin", () => {
  test("records a password sign-in once and a wrong password not at all", async () => {
    const { auth } = startAuth();
    await signUp(auth, "password@example.com");

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

  test("records nothing while auditing is off", async () => {
    const { auth } = startAuth(async () => false);
    await signUp(auth, "off@example.com");
    expect((await new Browser(auth).post("/sign-in/email", { email: "off@example.com", password: PASSWORD })).status).toBe(200);
    expect(entries).toEqual([]);
  });
});

describe("the app's Better Auth", () => {
  test("runs the audit hook after every plugin's after hooks", () => {
    const instance = buildAuth(envAuthConfig());
    const plugins = instance.options.plugins as Array<{ id: string }>;
    expect(plugins.at(-1)?.id).toBe("podokit-audit");
    expect(instance.options.hooks?.after).toBeUndefined();
  });

  test("classifies every endpoint that can sign a user in", () => {
    const instance = buildAuth(envAuthConfig());
    const paths = new Set(Object.values(instance.api as Record<string, { path?: string }>).map((endpoint) => endpoint.path ?? ""));
    expect(Object.keys(SIGN_IN_METHODS).filter((path) => !paths.has(path))).toEqual([]);
    const unclassified = [...paths].filter(
      (path) =>
        (path.startsWith("/sign-in/") || /callback|verify/.test(path)) &&
        SIGN_IN_METHODS[path] === undefined &&
        !STARTS_NO_SESSION.has(path),
    );
    expect(unclassified).toEqual([]);
  });
});
