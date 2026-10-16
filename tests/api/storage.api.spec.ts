import { expect, test, type APIRequestContext, type PlaywrightWorkerArgs } from "@playwright/test";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };
// The administrator seeded by the admin-dashboard Playwright setup. Inlined so this
// spec also compiles in apps that do not install that module.
const admin = {
  email: "admin@example.com",
  password: process.env.E2E_ADMIN_PASSWORD || "Podokit3e-Str0ng!pw",
};

type Playwright = PlaywrightWorkerArgs["playwright"];

function uniqueKey(): string {
  return `obj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  const email = `storage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await ctx.post("/api/auth/sign-up/email", { data: { email, password: "Podokit3e-Str0ng!pw", name: "S" } });
  return (await sessionRoles(ctx)) !== undefined;
}

/** Resolves false when no administrator session is available. */
async function signInAdmin(ctx: APIRequestContext): Promise<boolean> {
  const response = await ctx.post("/api/auth/sign-in/email", { data: admin });
  return response.ok() && ((await sessionRoles(ctx)) ?? []).includes("admin");
}

test("object storage: put, get, and presign @smoke", async ({ playwright }) => {
  const ctx = await newContext(playwright);
  const key = uniqueKey();
  try {
    test.skip(!(await signInAdmin(ctx)), "requires the auth module and the seeded administrator");
    const put = await ctx.put(`/api/storage/${key}`, { data: { content: "hello world" } });
    test.skip(!process.env.S3_ENDPOINT && put.status() >= 500, "optional S3-compatible service not configured");
    expect(put.ok()).toBeTruthy();
    expect(await put.json()).toMatchObject({ key });

    const read = await ctx.get(`/api/storage/${key}`);
    expect(read.ok()).toBeTruthy();
    expect(read.headers()["content-type"]).toContain("text/plain");
    expect(read.headers()["content-length"]).toBe("11");
    expect(read.headers()["last-modified"]).toBeTruthy();
    const etag = read.headers()["etag"];
    expect(etag).toMatch(/^"[^"]+"$/);
    expect(await read.text()).toBe("hello world");

    const revalidated = await ctx.get(`/api/storage/${key}`, { headers: { "if-none-match": etag ?? "" } });
    expect(revalidated.status()).toBe(304);

    const presigned = await ctx.get(`/api/storage/${key}/presigned`);
    expect(presigned.ok()).toBeTruthy();
    const pre = await presigned.json() as { url: string };
    expect(new URL(pre.url, base).pathname).toContain(`demo/${key}`);
    // The URL is signed for the API's S3 endpoint. A containerized dev stack signs an
    // in-network host, so download it only when the runner was given that endpoint too.
    if (process.env.S3_ENDPOINT) {
      const download = await ctx.get(pre.url);
      expect(download.ok()).toBeTruthy();
      expect(await download.text()).toBe("hello world");
    }
  } finally {
    await ctx.dispose();
  }
});

test("object storage demo routes are limited to administrators", async ({ playwright }) => {
  const anonymous = await newContext(playwright);
  const user = await newContext(playwright);
  const key = uniqueKey();
  try {
    test.skip(!(await signUp(user)), "requires the auth module");
    const unauthenticated = await anonymous.put(`/api/storage/${key}`, { data: { content: "x" } });
    expect(unauthenticated.status()).toBe(401);

    for (const response of [
      await user.put(`/api/storage/${key}`, { data: { content: "x" } }),
      await user.get(`/api/storage/${key}`),
      await user.get(`/api/storage/${key}/presigned`),
    ]) {
      expect(response.status()).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "ADMIN_REQUIRED" } });
    }
  } finally {
    await anonymous.dispose();
    await user.dispose();
  }
});

test("object storage demo keys cannot reach other features' objects", async ({ playwright }) => {
  const ctx = await newContext(playwright);
  try {
    test.skip(!(await signInAdmin(ctx)), "requires the auth module and the seeded administrator");
    for (const key of ["site%2Ffavicon", "profile-images%2Fx.png", "..%2Fsite%2Ffavicon", ".podokit"]) {
      const response = await ctx.put(`/api/storage/${key}`, { data: { content: "x" } });
      expect([400, 404], `PUT /api/storage/${key}`).toContain(response.status());
    }
  } finally {
    await ctx.dispose();
  }
});
