import { expect, test, type APIRequestContext, type PlaywrightWorkerArgs } from "@playwright/test";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };
// The administrator seeded by the admin-dashboard Playwright setup. Inlined so this
// spec also compiles in apps that do not install that module.
const admin = {
  email: process.env.E2E_ADMIN_EMAIL || "admin@example.com",
  password: process.env.E2E_ADMIN_PASSWORD || "Podokit3e-Str0ng!pw",
};

type Playwright = PlaywrightWorkerArgs["playwright"];

function uniqueKey(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function newContext(playwright: Playwright): Promise<APIRequestContext> {
  return playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
}

async function sessionRoles(ctx: APIRequestContext): Promise<string[] | undefined> {
  const response = await ctx.get("/api/auth/get-session");
  if (!response.ok()) return undefined;
  const session = await response.json() as { user?: { role?: string | null } } | null;
  if (!session?.user) return undefined;
  return (session.user.role ?? "").split(",").map((role) => role.trim()).filter(Boolean);
}

/** Resolves false when the auth module is missing or sign-up does not start a session. */
async function signUp(ctx: APIRequestContext): Promise<boolean> {
  const email = `storage-local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await ctx.post("/api/auth/sign-up/email", { data: { email, password: "Podokit3e-Str0ng!pw", name: "L" } });
  return (await sessionRoles(ctx)) !== undefined;
}

/** Resolves false when no administrator session is available. */
async function signInAdmin(ctx: APIRequestContext): Promise<boolean> {
  const response = await ctx.post("/api/auth/sign-in/email", { data: admin });
  return response.ok() && ((await sessionRoles(ctx)) ?? []).includes("admin");
}

test("local storage: signed download URLs reach only the signed object", async ({ playwright }) => {
  const ctx = await newContext(playwright);
  const anonymous = await newContext(playwright);
  const key = uniqueKey();
  try {
    test.skip(!(await signInAdmin(ctx)), "requires the auth module and the seeded administrator");
    const presigned = await ctx.get(`/api/storage/${key}/presigned`);
    const { url } = await presigned.json() as { url?: string };
    test.skip(!url?.startsWith("/files/content/"), "object-storage provider is not local");
    if (!url) throw new Error("presign response must include a url");
    expect(url).toContain(`/files/content/demo/${key}?`);
    expect((await ctx.put(`/api/storage/${key}`, { data: { content: "hello local" } })).ok()).toBeTruthy();

    const download = await anonymous.get(`/api${url}`);
    expect(download.ok()).toBeTruthy();
    expect(await download.text()).toBe("hello local");

    const unsigned = await anonymous.get(`/api${url.split("?")[0]}`);
    expect(unsigned.status()).toBe(403);
    expect(await unsigned.json()).toMatchObject({ error: { code: "DOWNLOAD_URL_INVALID" } });

    const altered = await anonymous.get(`/api${url.replace(`demo/${key}`, `demo/${key}-other`)}`);
    expect(altered.status()).toBe(403);
  } finally {
    await ctx.dispose();
    await anonymous.dispose();
  }
});

test("local storage demo routes are limited to administrators", async ({ playwright }) => {
  const user = await newContext(playwright);
  const key = uniqueKey();
  try {
    test.skip(!(await signUp(user)), "requires the auth module");
    for (const response of [
      await user.put(`/api/storage/${key}`, { data: { content: "x" } }),
      await user.get(`/api/storage/${key}`),
      await user.get(`/api/storage/${key}/presigned`),
    ]) {
      expect(response.status()).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "ADMIN_REQUIRED" } });
    }
  } finally {
    await user.dispose();
  }
});
