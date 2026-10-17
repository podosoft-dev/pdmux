import { expect, test, type APIRequestContext, type PlaywrightWorkerArgs } from "@playwright/test";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const secondaryApi = process.env.E2E_SECONDARY_API_URL;
const origin = { origin: base };
// The administrator seeded by the admin-dashboard Playwright setup. Inlined so this
// spec also compiles in apps that do not install that module.
const admin = {
  email: process.env.E2E_ADMIN_EMAIL || "admin@example.com",
  password: process.env.E2E_ADMIN_PASSWORD || "Podokit3e-Str0ng!pw",
};

type Playwright = PlaywrightWorkerArgs["playwright"];

interface SessionUser {
  id: string;
  roles: string[];
}

function newContext(playwright: Playwright): Promise<APIRequestContext> {
  return playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
}

async function sessionUser(ctx: APIRequestContext): Promise<SessionUser | undefined> {
  const response = await ctx.get("/api/auth/get-session");
  if (!response.ok()) return undefined;
  const session = await response.json() as { user?: { id?: string; role?: string | null } } | null;
  if (!session?.user?.id) return undefined;
  const roles = (session.user.role ?? "").split(",").map((role) => role.trim()).filter(Boolean);
  return { id: session.user.id, roles };
}

/** Resolves undefined when the auth module is missing or sign-up does not start a session. */
async function signUp(ctx: APIRequestContext): Promise<SessionUser | undefined> {
  const email = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await ctx.post("/api/auth/sign-up/email", { data: { email, password: "Podokit3e-Str0ng!pw", name: "E" } });
  return sessionUser(ctx);
}

/** Resolves false when no administrator session is available. */
async function signInAdmin(ctx: APIRequestContext): Promise<boolean> {
  const response = await ctx.post("/api/auth/sign-in/email", { data: admin });
  return response.ok() && ((await sessionUser(ctx))?.roles ?? []).includes("admin");
}

async function cookieHeader(ctx: APIRequestContext): Promise<string> {
  return (await ctx.storageState()).cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function uniqueTopic(): string {
  return `spec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

class EventStreamReader {
  private readonly decoder = new TextDecoder();
  private buffered = "";

  private constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly controller: AbortController,
  ) {}

  /** Opens a stream and waits for its retry hint, which proves the subscription is live. */
  static async open(ctx: APIRequestContext, topics: string): Promise<EventStreamReader> {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events/stream?topics=${encodeURIComponent(topics)}`, {
      headers: { ...origin, cookie: await cookieHeader(ctx) },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("event stream has no body");
    const stream = new EventStreamReader(reader, controller);
    await stream.until("retry:");
    return stream;
  }

  /** Returns everything received up to and including `text`. */
  async until(text: string, timeoutMs = 8_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (!this.buffered.includes(text)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${text}`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remaining);
      });
      const result = await Promise.race([this.reader.read(), timeout]);
      clearTimeout(timer);
      if (result === "timeout") continue;
      if (result.done) throw new Error(`stream ended before ${text}`);
      this.buffered += this.decoder.decode(result.value, { stream: true });
    }
    const end = this.buffered.indexOf(text) + text.length;
    const seen = this.buffered.slice(0, end);
    this.buffered = this.buffered.slice(end);
    return seen;
  }

  close(): void {
    this.controller.abort();
  }
}

test("sse: streams require a session and a valid topic list", async ({ playwright }) => {
  const anonymous = await newContext(playwright);
  const member = await newContext(playwright);
  try {
    test.skip(!(await signUp(member)), "requires the auth module");
    const unauthenticated = await fetch(`${base}/api/events/stream?topics=message`, { headers: origin });
    expect(unauthenticated.status).toBe(401);
    const invalid = await member.get("/api/events/stream?topics=bad%20topic");
    expect(invalid.status()).toBe(400);
    expect((await invalid.json()).error.code).toBe("EVENTS_TOPICS_INVALID");
  } finally {
    await anonymous.dispose();
    await member.dispose();
  }
});

function openStream(cookie: string, controller: AbortController): Promise<Response> {
  return fetch(`${base}/api/events/stream?topics=${uniqueTopic()}`, {
    headers: { ...origin, cookie },
    signal: controller.signal,
  });
}

test("sse: a user's open streams are capped per replica", async ({ playwright }) => {
  const member = await newContext(playwright);
  const other = await newContext(playwright);
  const controllers: AbortController[] = [];
  try {
    test.skip(!(await signUp(member)), "requires the auth module");
    expect(await signUp(other)).toBeDefined();
    const cookie = await cookieHeader(member);
    // The limit is SSE_MAX_STREAMS_PER_USER on the server, so open until refused.
    let refused: Response | undefined;
    for (let attempt = 0; attempt < 64 && !refused; attempt += 1) {
      const controller = new AbortController();
      const response = await openStream(cookie, controller);
      if (response.status === 200) controllers.push(controller);
      else refused = response;
    }
    expect(controllers.length).toBeGreaterThan(0);
    expect(refused?.status).toBe(429);
    expect((await refused?.json()).error.code).toBe("EVENTS_STREAM_LIMIT");

    // Another user is unaffected, and closing a stream frees its slot.
    const otherController = new AbortController();
    controllers.push(otherController);
    expect((await openStream(await cookieHeader(other), otherController)).status).toBe(200);
    controllers.shift()?.abort();
    await expect.poll(async () => {
      const controller = new AbortController();
      const response = await openStream(cookie, controller);
      if (response.status === 200) controllers.push(controller);
      else controller.abort();
      return response.status;
    }, { timeout: 8_000 }).toBe(200);
  } finally {
    for (const controller of controllers) controller.abort();
    await member.dispose();
    await other.dispose();
  }
});

test("sse: only administrators may publish", async ({ playwright }) => {
  const member = await newContext(playwright);
  try {
    test.skip(!(await signUp(member)), "requires the auth module");
    const published = await member.post("/api/events", { data: { message: "hello" } });
    expect(published.status()).toBe(403);
    expect((await published.json()).error.code).toBe("ADMIN_REQUIRED");
  } finally {
    await member.dispose();
  }
});

test("sse: an admin publish reaches only the addressed user @smoke", async ({ playwright }) => {
  const adminCtx = await newContext(playwright);
  const aliceCtx = await newContext(playwright);
  const bobCtx = await newContext(playwright);
  const streams: EventStreamReader[] = [];
  try {
    test.skip(!(await signInAdmin(adminCtx)), "requires the auth module and the seeded administrator");
    const alice = await signUp(aliceCtx);
    expect(alice).toBeDefined();
    expect(await signUp(bobCtx)).toBeDefined();
    const topic = uniqueTopic();
    const aliceStream = await EventStreamReader.open(aliceCtx, topic);
    const bobStream = await EventStreamReader.open(bobCtx, topic);
    streams.push(aliceStream, bobStream);

    const secret = `secret-${Date.now()}`;
    const done = `done-${Date.now()}`;
    const targeted = await adminCtx.post("/api/events", {
      data: { topic, audience: { userIds: [alice?.id] }, message: secret },
    });
    expect(targeted.status()).toBe(201);
    expect(await targeted.json()).toEqual({ ok: true });
    expect((await adminCtx.post("/api/events", { data: { topic, message: done } })).status()).toBe(201);

    const aliceSaw = await aliceStream.until(done);
    expect(aliceSaw).toContain(JSON.stringify({ topic, data: { message: secret } }));
    expect(await bobStream.until(done)).not.toContain(secret);
  } finally {
    for (const stream of streams) stream.close();
    await adminCtx.dispose();
    await aliceCtx.dispose();
    await bobCtx.dispose();
  }
});

test("sse: a second API replica delivers through Redis", async ({ playwright }) => {
  test.skip(!secondaryApi, "a secondary API replica is not configured");
  const adminCtx = await newContext(playwright);
  const memberCtx = await newContext(playwright);
  let stream: EventStreamReader | undefined;
  try {
    test.skip(!(await signInAdmin(adminCtx)), "requires the auth module and the seeded administrator");
    const member = await signUp(memberCtx);
    expect(member).toBeDefined();
    const topic = uniqueTopic();
    stream = await EventStreamReader.open(memberCtx, topic);

    const message = `replica-${Date.now()}`;
    const published = await fetch(`${secondaryApi}/events`, {
      method: "POST",
      headers: { ...origin, cookie: await cookieHeader(adminCtx), "content-type": "application/json" },
      body: JSON.stringify({ topic, audience: { userIds: [member?.id] }, message }),
    });
    expect(published.status).toBe(201);

    const done = `done-${Date.now()}`;
    expect((await adminCtx.post("/api/events", { data: { topic, message: done } })).status()).toBe(201);
    const seen = await stream.until(done);
    expect(seen.split(message).length - 1).toBe(1);
  } finally {
    stream?.close();
    await adminCtx.dispose();
    await memberCtx.dispose();
  }
});
