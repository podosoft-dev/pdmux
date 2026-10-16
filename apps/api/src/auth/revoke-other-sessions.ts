import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";

/** Sessions read and revoked per pass. */
const BATCH_SIZE = 500;

/**
 * Makes `/revoke-other-sessions` revoke every other session of the user.
 * Better Auth's endpoint lists the sessions through the adapter's default
 * findMany limit of 100 and revokes only those, so a user with more sessions
 * kept the rest after "sign out other sessions". This hook runs after the
 * endpoint and revokes the remainder in batches through the internal adapter,
 * which also clears their secondary-storage entries when one is configured.
 */
export function revokeEveryOtherSession(): BetterAuthPlugin {
  return {
    id: "podokit-revoke-every-other-session",
    hooks: {
      after: [
        {
          matcher: (context) => context.path === "/revoke-other-sessions",
          handler: createAuthMiddleware(async (ctx) => {
            const current = ctx.context.session;
            if (!current) return;
            let first: string | undefined;
            for (;;) {
              const others = await ctx.context.adapter.findMany<{ token: string }>({
                model: "session",
                where: [
                  { field: "userId", value: current.user.id },
                  { field: "token", value: current.session.token, operator: "ne" },
                ],
                limit: BATCH_SIZE,
              });
              // Stop when nothing is left, or when a pass removed nothing.
              if (others.length === 0 || others[0]?.token === first) return;
              first = others[0]?.token;
              await ctx.context.internalAdapter.deleteSessions(others.map((session) => session.token));
            }
          }),
        },
      ],
    },
  };
}
