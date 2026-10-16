import { describe, expect, test } from "bun:test";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { revokeEveryOtherSession } from "./revoke-other-sessions";

type Row = Record<string, unknown>;

// A user signed in once more than Better Auth's default findMany limit of 100
// sessions per list allows, plus the 50 extra the endpoint used to leave behind.
const EXTRA_SESSIONS = 150;

async function signedInWithManySessions(plugins: BetterAuthPlugin[]): Promise<{
  revokeOthers: () => Promise<unknown>;
  sessions: () => Row[];
  currentToken: string;
}> {
  const db: Record<string, Row[]> = { user: [], session: [], account: [], verification: [] };
  const auth = betterAuth({
    database: memoryAdapter(db),
    secret: "revoke-other-sessions-test-secret-0123456789",
    baseURL: "http://localhost:5002",
    emailAndPassword: { enabled: true },
    plugins,
  });
  const response = await auth.api.signUpEmail({
    body: { email: "many@example.com", password: "Podokit3e-Str0ng!pw", name: "Many" },
    asResponse: true,
  });
  const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const context = await auth.$context;
  const userId = String(db.user[0]?.id);
  for (let index = 0; index < EXTRA_SESSIONS; index += 1) {
    await context.internalAdapter.createSession(userId);
  }
  const currentToken = String((await auth.api.getSession({ headers: new Headers({ cookie }) }))?.session.token);
  return {
    revokeOthers: () => auth.api.revokeOtherSessions({ headers: new Headers({ cookie }) }),
    sessions: () => db.session ?? [],
    currentToken,
  };
}

describe("revokeEveryOtherSession", () => {
  test("Better Auth alone revokes only the first 100 other sessions", async () => {
    const user = await signedInWithManySessions([]);
    expect(user.sessions()).toHaveLength(EXTRA_SESSIONS + 1);
    await user.revokeOthers();
    expect(user.sessions().length).toBeGreaterThan(1);
  });

  test("revokes every other session and keeps the current one", async () => {
    const user = await signedInWithManySessions([revokeEveryOtherSession()]);
    await user.revokeOthers();
    expect(user.sessions().map((session) => session.token)).toEqual([user.currentToken]);
  });
});
