import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getAuthTables } from "better-auth/db";
import { admin, magicLink } from "better-auth/plugins";
import { adminEmailProblem, adminEmailsFrom, becomesAdministrator } from "./admin-emails";
import { databaseHooksFor } from "./auth";
import { PUBLIC_SIGNUP_DISABLED } from "./feature-gate";

const BASE_URL = "http://localhost:5002";
const PASSWORD = "Podokit3e-Str0ng!pw";
const ADMIN_EMAIL = "owner@podokit.dev";

describe("ADMIN_EMAILS", () => {
  test("keeps placeholders outside production and refuses them in production", () => {
    expect([...adminEmailsFrom(" Admin@Example.com, ,ops@podokit.dev ", false)]).toEqual([
      "admin@example.com",
      "ops@podokit.dev",
    ]);
    expect([...adminEmailsFrom("owner@podokit.dev,ops@mail.podokit.dev", true)]).toHaveLength(2);
    expect(adminEmailsFrom(undefined, true).size).toBe(0);
    expect(adminEmailsFrom("", true).size).toBe(0);
    for (const entry of [
      "admin@example.com",
      "a@mail.example.org",
      "a@example.net",
      "a@host.test",
      "a@host.example",
      "a@host.invalid",
      "a@localhost",
      "admin",
      "a@b",
    ]) {
      expect(() => adminEmailsFrom(`owner@podokit.dev,${entry}`, true)).toThrow(`"${entry}"`);
    }
  });

  test("stops a production API whose ADMIN_EMAILS holds a placeholder", () => {
    // The child loads auth.ts with this test's environment, as this file did,
    // then evaluates auth.ts again in production. The second import is a new
    // instance of auth.ts alone: its dependencies are already loaded, so the
    // application's own production rules in env.extensions.ts, which this test
    // cannot know, never run before auth.ts reads ADMIN_EMAILS.
    const auth = JSON.stringify(join(__dirname, "auth.ts"));
    const message = "ADMIN_EMAILS must list real administrator addresses in production";
    const load = (adminEmails: string): { exitCode: number; stderr: string } => {
      const production = {
        NODE_ENV: "production",
        ADMIN_EMAILS: adminEmails,
        BETTER_AUTH_SECRET: "admin-emails-production-secret-0123456789",
        BETTER_AUTH_URL: "https://app.podokit.dev",
      };
      const script = [
        `await import(${auth});`,
        `Object.assign(process.env, ${JSON.stringify(production)});`,
        `await import(${auth} + "?production");`,
        "process.exit(0);",
      ].join("\n");
      const result = Bun.spawnSync([process.execPath, "--eval", script], { env: { ...process.env }, stderr: "pipe" });
      return { exitCode: result.exitCode, stderr: result.stderr.toString() };
    };
    const placeholder = load("admin@example.com");
    expect(placeholder.exitCode).not.toBe(0);
    expect(placeholder.stderr).toContain(message);
    expect(load("owner@podokit.dev").stderr).not.toContain(message);
  });

  test("names why an entry is no administrator's address", () => {
    expect(adminEmailProblem("admin@example.com")).toBe("a placeholder on a reserved domain");
    expect(adminEmailProblem("someone@example.company")).toBeNull();
    expect(adminEmailProblem("admin")).toBe("not an email address");
    expect(adminEmailProblem("owner@podokit.dev")).toBeNull();
  });

  test("promotes a listed address only once it is proven", () => {
    const listed = new Set([ADMIN_EMAIL]);
    expect(becomesAdministrator({ email: "Owner@Podokit.dev", emailVerified: true }, false, listed)).toBe(true);
    expect(becomesAdministrator({ email: ADMIN_EMAIL, emailVerified: false }, true, listed)).toBe(true);
    expect(becomesAdministrator({ email: "else@podokit.dev", emailVerified: false }, false, listed)).toBe(false);
    expect(() => becomesAdministrator({ email: ADMIN_EMAIL, emailVerified: false }, false, listed)).toThrow(
      "cannot be registered",
    );
  });
});

interface StartOptions {
  requireSignupApproval?: boolean;
  googleEmailVerified?: boolean;
}

// The account rules of the generated auth.ts on an in-memory database, with
// sign-up open and ADMIN_EMAILS naming ADMIN_EMAIL.
function startAuth({ requireSignupApproval = false, googleEmailVerified = true }: StartOptions = {}) {
  const mail = { magicLink: "" };
  const db: Record<string, Record<string, unknown>[]> = {};
  const options = {
    baseURL: BASE_URL,
    secret: "admin-emails-test-secret-0123456789abcdef",
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true, autoSignIn: !requireSignupApproval },
    user: { additionalFields: { signupApproved: { type: "boolean" as const, required: false, defaultValue: true, input: false } } },
    socialProviders: {
      google: {
        clientId: "client",
        clientSecret: "secret",
        getUserInfo: async () => ({
          user: { email: ADMIN_EMAIL, name: "Owner", emailVerified: googleEmailVerified },
          data: {
            sub: "google-1",
            email: ADMIN_EMAIL,
            email_verified: googleEmailVerified,
            name: "Owner",
            given_name: "Owner",
            family_name: "Podokit",
            picture: "https://podokit.dev/owner.png",
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
      magicLink({
        sendMagicLink: async ({ url }) => {
          mail.magicLink = url;
        },
      }),
      admin(),
    ],
    databaseHooks: databaseHooksFor({ requireSignupApproval }, new Set([ADMIN_EMAIL]), async () => true),
  };
  for (const table of Object.values(getAuthTables(options))) db[table.modelName] = [];
  const auth = betterAuth(options);
  const users = (): Array<{ email: string; role?: string; signupApproved?: boolean; emailVerified?: boolean }> =>
    (db.user ?? []) as Array<{ email: string; role?: string; signupApproved?: boolean; emailVerified?: boolean }>;
  const request = (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}): Promise<Response> =>
    auth.handler(
      new Request(path.startsWith("http") ? path : `${BASE_URL}/api/auth${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: {
          origin: BASE_URL,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...(init.cookie ? { cookie: init.cookie } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        redirect: "manual",
      }),
    );
  return { auth, mail, users, request };
}

const cookiesOf = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

// Signs in with Google, answering the provider's token request.
async function googleSignIn(started: ReturnType<typeof startAuth>): Promise<Response> {
  const realFetch = globalThis.fetch;
  const tokenEndpoint = spyOn(globalThis, "fetch").mockImplementation(((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Promise.resolve(Response.json({ access_token: "access", expires_in: 3600, token_type: "Bearer" }));
    }
    return realFetch(input, init);
  }) as typeof fetch);
  try {
    const begin = await started.request("/sign-in/social", { body: { provider: "google", callbackURL: `${BASE_URL}/` } });
    const state = new URL(((await begin.json()) as { url: string }).url).searchParams.get("state") ?? "";
    return await started.request(`/callback/google?code=code&state=${encodeURIComponent(state)}`, {
      cookie: cookiesOf(begin),
    });
  } finally {
    tokenEndpoint.mockRestore();
  }
}

describe("accounts with an ADMIN_EMAILS address", () => {
  test("refuses an unverified email sign-up instead of making an administrator", async () => {
    const open = startAuth();
    const refused = await open.request("/sign-up/email", { body: { email: ADMIN_EMAIL, password: PASSWORD, name: "Claim" } });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code?: string }).code).toBe(PUBLIC_SIGNUP_DISABLED);
    expect(open.users()).toEqual([]);

    // With sign-up approval on, Better Auth answers a refused sign-up like any
    // other, so the response does not reveal the address; still no account.
    const pending = startAuth({ requireSignupApproval: true });
    const hidden = await pending.request("/sign-up/email", { body: { email: ADMIN_EMAIL, password: PASSWORD, name: "Claim" } });
    expect(hidden.status).toBe(200);
    expect(pending.users()).toEqual([]);
    const signIn = await pending.request("/sign-in/email", { body: { email: ADMIN_EMAIL, password: PASSWORD } });
    expect(signIn.status).toBe(401);

    // Other addresses sign up as before: pending under the approval policy.
    expect((await pending.request("/sign-up/email", { body: { email: "member@podokit.dev", password: PASSWORD, name: "M" } })).status).toBe(200);
    expect(pending.users()).toEqual([expect.objectContaining({ email: "member@podokit.dev", role: "user", signupApproved: false })]);
  });

  test("makes an approved administrator of a social sign-in with a verified address", async () => {
    const started = startAuth({ requireSignupApproval: true });
    const callback = await googleSignIn(started);
    expect(callback.status).toBe(302);
    expect(new URL(callback.headers.get("location") ?? "", BASE_URL).searchParams.get("error")).toBeNull();
    expect(started.users()).toEqual([
      expect.objectContaining({ email: ADMIN_EMAIL, role: "admin", signupApproved: true, emailVerified: true }),
    ]);

    const unverified = startAuth({ requireSignupApproval: true, googleEmailVerified: false });
    const refused = await googleSignIn(unverified);
    expect(refused.status).toBe(302);
    expect(new URL(refused.headers.get("location") ?? "", BASE_URL).searchParams.get("error")).toBeTruthy();
    expect(unverified.users()).toEqual([]);
  });

  test("makes an administrator of a magic link sign-in, which proves the address", async () => {
    const started = startAuth({ requireSignupApproval: true });
    await started.request("/sign-in/magic-link", { body: { email: ADMIN_EMAIL, callbackURL: `${BASE_URL}/` } });
    expect((await started.request(started.mail.magicLink)).status).toBe(302);
    expect(started.users()).toEqual([expect.objectContaining({ email: ADMIN_EMAIL, role: "admin", signupApproved: true })]);
  });

  test("creates the administrator that admin:bootstrap asks for", async () => {
    const started = startAuth({ requireSignupApproval: true });
    // scripts/bootstrap-admin.mjs creates the account through this call.
    await started.auth.api.createUser({
      body: { email: ADMIN_EMAIL, password: PASSWORD, name: "Administrator", role: "admin", data: { emailVerified: true, signupApproved: true } },
    });
    expect(started.users()).toEqual([
      expect.objectContaining({ email: ADMIN_EMAIL, role: "admin", signupApproved: true, emailVerified: true }),
    ]);
    expect((await started.request("/sign-in/email", { body: { email: ADMIN_EMAIL, password: PASSWORD } })).status).toBe(200);
  });
});
