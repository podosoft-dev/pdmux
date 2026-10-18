import { AsyncLocalStorage } from "node:async_hooks";
import { timingSafeEqual } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod/v4";

const ownerCreation = new AsyncLocalStorage<boolean>();
let capability: string | undefined;
let prepareProfile: (() => Promise<void>) | undefined;

export function isDesktopRuntime(): boolean {
  return process.env.PDMUX_DESKTOP_RUNTIME === "1" && process.env.DATABASE_PROVIDER === "sqlite" && process.env.HOST === "127.0.0.1";
}

/** The capability arrives over a private pipe, never a URL, argv or the renderer. */
export async function initializeDesktopRuntime(prepare: () => Promise<void>): Promise<void> {
  if (!isDesktopRuntime()) return;
  const input: unknown = JSON.parse(await Bun.stdin.text());
  if (!input || typeof input !== "object" || !("capability" in input) || typeof input.capability !== "string" || input.capability.length < 43) {
    throw new Error("Missing desktop runtime capability");
  }
  capability = input.capability;
  prepareProfile = prepare;
}

/** Only the capability-checked bootstrap may provision a passwordless local owner. */
export function isDesktopOwnerCreation(): boolean {
  return isDesktopRuntime() && ownerCreation.getStore() === true;
}

export function requireDesktopCapability(request: Request | undefined): void {
  const value = request?.headers.get("x-pdmux-desktop-capability") ?? "";
  if (!isDesktopRuntime() || !capability || Buffer.byteLength(value) !== Buffer.byteLength(capability) || !timingSafeEqual(Buffer.from(value), Buffer.from(capability))) {
    throw new APIError("NOT_FOUND", { message: "Not found" });
  }
}

export function desktopLocalAuth(): BetterAuthPlugin {
  return {
    id: "pdmux-desktop-local",
    endpoints: {
      desktopLocalProfiles: createAuthEndpoint("/desktop-local/profiles", { method: "POST" }, async (ctx) => {
        requireDesktopCapability(ctx.request);
        const users = await ctx.context.adapter.findMany<{ id: string; name: string; email: string }>({ model: "user", limit: 1_000 });
        return ctx.json(users.map(({ id, name, email }) => ({ id, name, email })));
      }),
      desktopLocalSession: createAuthEndpoint("/desktop-local/session", {
        method: "POST", body: z.object({ profileId: z.string().optional() }),
      }, async (ctx) => {
        requireDesktopCapability(ctx.request);
        const users = await ctx.context.adapter.findMany<{ id: string; name: string; email: string }>({ model: "user", limit: 1_000 });
        if (users.length > 1 && !ctx.body.profileId) throw new APIError("CONFLICT", { message: "Select a local profile" });
        let user = ctx.body.profileId ? await ctx.context.internalAdapter.findUserById(ctx.body.profileId) :
          users[0] ? await ctx.context.internalAdapter.findUserById(users[0].id) : null;
        if (ctx.body.profileId && !user) throw new APIError("NOT_FOUND", { message: "Local profile not found" });
        if (!user) user = await ownerCreation.run(true, () => ctx.context.internalAdapter.createUser({
          name: "Local", email: `desktop-${crypto.randomUUID()}@local.invalid`, emailVerified: true,
          role: "admin", signupApproved: true,
        }, { method: "admin" }));
        await prepareProfile?.();
        const session = await ctx.context.internalAdapter.createSession(user.id);
        if (!session) throw new APIError("INTERNAL_SERVER_ERROR", { message: "Cannot create local session" });
        await setSessionCookie(ctx, { user, session });
        return ctx.json({ profileId: user.id, expiresAt: session.expiresAt });
      }),
    },
  };
}
