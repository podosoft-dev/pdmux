import { auth as bootstrapAuth, buildAuth } from "./auth";
import { authConfigStore } from "./auth-config-store";

// Runtime auth instance that rebuilds when the DB config changes, so admin edits
// (OAuth credentials, SMTP, server-enforced toggles) apply WITHOUT a restart.
//
// @thallesp/nestjs-better-auth reads `auth.handler` exactly once (via toNodeHandler)
// and `auth.api` per request. We hand it a Proxy: `.handler` is a STABLE delegating
// function (so the adapter's captured reference stays valid) that redispatches each
// request to the currently-built instance; every other access forwards to the
// current instance too. The guard/session behavior is unchanged (session tokens are
// signed with the stable BETTER_AUTH_SECRET; trustedOrigins is baked into every build).

const TTL_MS = 3_000;

let current = bootstrapAuth;
let currentVersion = "env"; // matches envAuthConfig() bootstrap
let checkedAt = 0;
let inflight: Promise<void> | null = null;

export function getAuth(): typeof bootstrapAuth {
  return current;
}

/** Rebuild the instance if the DB config version changed. Cheap and throttled to
 *  TTL; single-flight so concurrent requests trigger at most one rebuild; keeps the
 *  last-good instance if loading/building fails, so auth never goes down. */
export async function refreshIfStale(): Promise<void> {
  if (checkedAt !== 0 && Date.now() - checkedAt < TTL_MS) return;
  checkedAt = Date.now();
  let latest: string;
  try {
    latest = await authConfigStore.currentVersion();
  } catch {
    return; // DB blip — keep serving the last-good instance
  }
  if (latest === currentVersion) return;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const config = await authConfigStore.load();
      current = buildAuth(config);
      currentVersion = config.version;
    } catch (err) {
      console.error("[auth-config] rebuild failed; keeping last-good auth instance:", err instanceof Error ? err.message : err);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Apply a successful in-process admin write before the response is returned. */
export async function refreshAuthNow(): Promise<void> {
  authConfigStore.invalidate();
  checkedAt = 0;
  // Force a rebuild even if two writes receive the same millisecond timestamp.
  currentVersion = `stale:${Date.now()}`;
  await refreshIfStale();
}

// Stable handler reference the adapter captures once; redispatches per request.
const dynamicHandler: typeof bootstrapAuth.handler = async (request) => {
  await refreshIfStale();
  return current.handler(request);
};

export const authRuntime: typeof bootstrapAuth = new Proxy(bootstrapAuth, {
  get(_target, prop) {
    if (prop === "handler") return dynamicHandler;
    const value = Reflect.get(current, prop, current);
    return typeof value === "function" ? value.bind(current) : value;
  },
});

/** Optional boot preload so the first request doesn't pay the initial DB read. */
export async function primeAuth(): Promise<void> {
  checkedAt = 0;
  await refreshIfStale();
}
