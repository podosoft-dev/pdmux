import { expect, test } from "@playwright/test";
import {
  PUBLIC_SIGNUP_DISABLED,
  isUserCreationAllowed,
} from "../../apps/api/src/auth/feature-gate";
import { ADMIN } from "../helpers/accounts";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };

// Fresh admin context (not the shared storageState) so these never rotate the
// seeded admin session.
async function adminCtx(playwright: import("@playwright/test").PlaywrightWorkerArgs["playwright"]) {
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await ctx.post("/api/auth/sign-in/email", { data: { email: ADMIN.email, password: ADMIN.password } });
  return ctx;
}

test("admin can enable Google OAuth from the DB and it applies without a restart", async ({ playwright }) => {
  const admin = await adminCtx(playwright);
  await admin.put("/api/account/auth-config", { data: { social: { google: { enabled: false } } } }); // clean start
  const anon = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const social = () => anon.post("/api/auth/sign-in/social", { data: { provider: "google", callbackURL: `${base}/admin` } });

  // Before: provider not configured.
  await expect.poll(async () => (await social()).status(), { timeout: 8000 }).toBe(404);

  // Paste credentials via the admin API.
  const put = await admin.put("/api/account/auth-config", {
    data: { social: { google: { enabled: true, clientId: "dummy-google-client-id", clientSecret: "dummy-google-client-secret" } } },
  });
  expect(put.ok()).toBeTruthy();
  const view = await put.json();
  expect(view.social.google.hasSecret).toBe(true);
  expect(view.social.google.clientId).toBe("dummy-google-client-id");
  expect("clientSecret" in view.social.google).toBe(false); // secret is never returned

  // Applied live (no restart): social sign-in now redirects to Google.
  await expect
    .poll(async () => {
      const r = await social();
      return r.ok() ? (((await r.json())?.url as string) ?? "") : "";
    }, { timeout: 8000 })
    .toContain("accounts.google.com");
  const caps = await (await anon.get("/api/account/capabilities")).json();
  expect(caps.providers).toContain("google");

  await admin.put("/api/account/auth-config", { data: { social: { google: { enabled: false } } } }); // restore
  await anon.dispose();
  await admin.dispose();
});

test("admin can add and remove a social provider dynamically", async ({ playwright }) => {
  const admin = await adminCtx(playwright);
  // The catalog offers providers beyond the two legacy env-backed ones.
  const catalog = (await (await admin.get("/api/account/auth-config")).json()).catalog as Array<{ id: string }>;
  expect(catalog.map((c) => c.id)).toEqual(expect.arrayContaining(["google", "github", "apple"]));

  const anon = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const github = () => anon.post("/api/auth/sign-in/social", { data: { provider: "github", callbackURL: `${base}/admin` } });

  // Add GitHub (a provider with no env fallback) → applies live, no restart.
  await admin.put("/api/account/auth-config", { data: { social: { github: { enabled: true, clientId: "dummy-github-client-id", clientSecret: "dummy-github-client-secret" } } } });
  await expect
    .poll(async () => { const r = await github(); return r.ok() ? (((await r.json())?.url as string) ?? "") : ""; }, { timeout: 8000 })
    .toContain("github.com");

  // Remove it → the row is deleted and the provider stops working (again live).
  await admin.put("/api/account/auth-config", { data: { social: { github: { delete: true } } } });
  expect("github" in (await (await admin.get("/api/account/auth-config")).json()).social).toBe(false);
  await expect.poll(async () => (await github()).status(), { timeout: 8000 }).toBe(404);

  await anon.dispose();
  await admin.dispose();
});

test("auth-config is admin-only and never leaks secrets @smoke", async ({ playwright }) => {
  const user = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const email = `acfg-${Date.now()}@example.com`;
  await user.post("/api/auth/sign-up/email", { data: { email, password: "Podokit3e-Str0ng!pw", name: "U" } });
  expect((await user.get("/api/account/auth-config")).status()).toBe(403);
  expect((await user.put("/api/account/auth-config", { data: { server: { hibp: true } } })).status()).toBe(403);
  await user.dispose();
});

test("automatic logout validates and applies a sliding session lifetime", async ({ playwright }) => {
  const admin = await adminCtx(playwright);
  const freshAdmin = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });

  try {
    expect(
      (await admin.put("/api/account/auth-config", {
        data: { server: { sessionIdleTimeoutMinutes: 4 } },
      })).status(),
    ).toBe(400);

    const enabled = await admin.put("/api/account/auth-config", {
      data: { server: { sessionIdleTimeoutMinutes: 30 } },
    });
    expect(enabled.ok()).toBeTruthy();
    expect((await enabled.json()).server.sessionIdleTimeoutMinutes).toBe(30);

    const caps = await (await admin.get("/api/account/capabilities")).json();
    expect(caps.sessionIdleTimeoutMinutes).toBe(30);

    const signIn = await freshAdmin.post("/api/auth/sign-in/email", {
      data: { email: ADMIN.email, password: ADMIN.password },
    });
    expect(signIn.ok()).toBeTruthy();
    expect(signIn.headers()["set-cookie"]).toMatch(/Max-Age=1800(?:;|,)/i);

    const sessions = (await (await admin.get("/api/auth/list-sessions")).json()) as Array<{
      expiresAt: string;
    }>;
    const latestExpiry = Math.max(...sessions.map((session) => new Date(session.expiresAt).getTime()));
    expect(latestExpiry).toBeLessThanOrEqual(Date.now() + 30 * 60_000 + 10_000);
  } finally {
    await admin.put("/api/account/auth-config", {
      data: { server: { sessionIdleTimeoutMinutes: null } },
    });
    await freshAdmin.dispose();
    await admin.dispose();
  }
});

test("new registrations require approval when the policy is enabled", async ({ playwright }) => {
  const admin = await adminCtx(playwright);
  const anon = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const password = "Podokit3e-Str0ng!pw";
  const email = `approval-${Date.now()}@example.com`;
  const adminCreatedEmail = `approval-admin-${Date.now()}@example.com`;
  let pendingId = "";
  let adminCreatedId = "";

  try {
    const enabled = await admin.put("/api/account/auth-config", {
      data: { server: { requireSignupApproval: true } },
    });
    expect(enabled.ok()).toBeTruthy();
    expect((await enabled.json()).server.requireSignupApproval).toBe(true);

    // authRuntime and its config store use a short cache; an auth request after
    // the TTL applies the new policy without restarting the process.
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    await anon.get("/api/auth/get-session");

    const signup = await anon.post("/api/auth/sign-up/email", {
      data: { email, password, name: "Pending User" },
    });
    expect(signup.ok()).toBeTruthy();
    expect((await signup.json()).token).toBeNull();
    expect((await anon.get("/api/auth/get-session")).status()).toBe(200);
    expect((await (await anon.get("/api/auth/get-session")).json())?.session).toBeFalsy();

    const listed = await admin.get(
      `/api/auth/admin/list-users?searchValue=${encodeURIComponent(email)}&searchField=email`,
    );
    const pending = ((await listed.json()).users ?? [])[0] as {
      id: string;
      signupApproved?: boolean | null;
    };
    pendingId = pending.id;
    expect(pending.signupApproved).toBe(false);

    const blocked = await anon.post("/api/auth/sign-in/email", { data: { email, password } });
    expect(blocked.status()).toBe(403);
    expect((await blocked.json()).code).toBe("SIGNUP_APPROVAL_REQUIRED");

    const approved = await admin.post("/api/auth/admin/update-user", {
      data: { userId: pendingId, data: { signupApproved: true } },
    });
    expect(approved.ok()).toBeTruthy();
    expect((await approved.json()).signupApproved).toBe(true);
    expect((await anon.post("/api/auth/sign-in/email", { data: { email, password } })).ok()).toBeTruthy();

    // Accounts created intentionally by an administrator bypass the queue.
    const adminCreated = await admin.post("/api/auth/admin/create-user", {
      data: { email: adminCreatedEmail, password, name: "Admin Created", role: "user" },
    });
    expect(adminCreated.ok()).toBeTruthy();
    const adminCreatedUser = (await adminCreated.json()).user as {
      id: string;
      signupApproved?: boolean | null;
    };
    adminCreatedId = adminCreatedUser.id;
    expect(adminCreatedUser.signupApproved).toBe(true);
    const adminCreatedSession = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
    expect(
      (await adminCreatedSession.post("/api/auth/sign-in/email", {
        data: { email: adminCreatedEmail, password },
      })).ok(),
    ).toBeTruthy();
    await adminCreatedSession.dispose();
  } finally {
    if (pendingId) await admin.post("/api/auth/admin/remove-user", { data: { userId: pendingId } });
    if (adminCreatedId) await admin.post("/api/auth/admin/remove-user", { data: { userId: adminCreatedId } });
    await admin.put("/api/account/auth-config", { data: { server: { requireSignupApproval: false } } });
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    await anon.get("/api/auth/get-session");
    await anon.dispose();
    await admin.dispose();
  }
});

test("closed public sign-up blocks new OAuth users but preserves existing sign-in", async ({ playwright }) => {
  const admin = await adminCtx(playwright);
  const anon = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const password = "Podokit3e-Str0ng!pw";
  const adminCreatedEmail = `closed-admin-${Date.now()}@example.com`;
  const initialSite = (await (await anon.get("/api/site/settings")).json()) as {
    allowSignup?: string | null;
  };
  const initialAllowSignup = initialSite.allowSignup === "false" ? "false" : "true";
  let adminCreatedId = "";

  try {
    expect(
      (await admin.put("/api/account/auth-config", {
        data: {
          social: {
            google: {
              enabled: true,
              clientId: "dummy-google-client-id",
              clientSecret: "dummy-google-client-secret",
            },
          },
        },
      })).ok(),
    ).toBeTruthy();
    expect((await admin.put("/api/site/settings", { data: { allowSignup: "false" } })).ok()).toBeTruthy();

    // The site policy uses a short cache shared by sign-up requests and user
    // creation hooks, so wait for the setting to become live.
    await new Promise((resolve) => setTimeout(resolve, 3_200));

    const signup = await anon.post("/api/auth/sign-up/email", {
      data: {
        email: `closed-${Date.now()}@example.com`,
        password,
        name: "Closed Registration",
      },
    });
    expect(signup.status()).toBe(403);
    expect((await signup.json()).code).toBe(PUBLIC_SIGNUP_DISABLED);

    // OAuth initiation must stay available for existing social users. Only a
    // callback that attempts to create a new user is rejected by the DB hook.
    const social = await anon.post("/api/auth/sign-in/social", {
      data: { provider: "google", callbackURL: `${base}/` },
    });
    expect(social.ok()).toBeTruthy();
    expect(((await social.json()).url as string)).toContain("accounts.google.com");
    expect(isUserCreationAllowed(false, "/callback/google")).toBe(false);
    expect(isUserCreationAllowed(false, undefined)).toBe(false);

    // Deliberate administrator provisioning remains available while the public
    // site is closed.
    expect(isUserCreationAllowed(false, "/admin/create-user")).toBe(true);
    const adminCreated = await admin.post("/api/auth/admin/create-user", {
      data: { email: adminCreatedEmail, password, name: "Admin Created", role: "user" },
    });
    expect(adminCreated.ok()).toBeTruthy();
    adminCreatedId = ((await adminCreated.json()).user as { id: string }).id;
  } finally {
    if (adminCreatedId) {
      await admin.post("/api/auth/admin/remove-user", { data: { userId: adminCreatedId } });
    }
    await admin.put("/api/site/settings", { data: { allowSignup: initialAllowSignup } });
    await admin.put("/api/account/auth-config", {
      data: { social: { google: { enabled: false } } },
    });
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    await anon.get("/api/auth/get-session");
    await anon.dispose();
    await admin.dispose();
  }
});
