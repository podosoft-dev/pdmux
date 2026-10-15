import type { AuthConfig } from "@podosoft/podokit-auth";
import { auth as bootstrapAuth, buildAuth } from "./auth";
import { authConfigStore } from "./auth-config-store";
import { publishConfigChanged } from "./config-events";

// Runtime auth instance that rebuilds when the DB config changes, so admin edits
// (OAuth credentials, SMTP, server-enforced toggles) apply WITHOUT a restart.
//
// Elysia mounts `auth.handler` once. The proxy exposes a stable delegating handler
// that refreshes the DB-backed configuration and dispatches to the current Better
// Auth instance. Session tokens remain valid because BETTER_AUTH_SECRET is stable.

let current = bootstrapAuth;
let currentVersion = "env"; // matches envAuthConfig() bootstrap
let failedVersion: string | null = null;

export function getAuth(): typeof bootstrapAuth {
  return current;
}

/** Rebuild the instance if the DB config version changed. The config store
 *  throttles its version probe to its TTL and shares one refresh between
 *  concurrent callers, so this is cheap per request. Keeps the last-good instance
 *  if loading or building fails, so auth never goes down. */
export async function refreshIfStale(): Promise<void> {
  let config: AuthConfig;
  try {
    config = await authConfigStore.load();
  } catch {
    return; // DB blip — keep serving the last-good instance
  }
  // A config that failed to build is retried only after it changes.
  if (config.version === currentVersion || config.version === failedVersion) return;
  try {
    current = buildAuth(config);
    currentVersion = config.version;
    failedVersion = null;
  } catch (err) {
    failedVersion = config.version;
    console.error("[auth-config] rebuild failed; keeping last-good auth instance:", err instanceof Error ? err.message : err);
  }
}

/** Apply a successful in-process admin write before the response is returned,
 *  and tell other replicas when an events provider is installed. */
export async function refreshAuthNow(): Promise<void> {
  authConfigStore.invalidate();
  // Force a rebuild even if the write left the version token unchanged.
  currentVersion = `stale:${Date.now()}`;
  failedVersion = null;
  await refreshIfStale();
  await publishConfigChanged();
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
  await refreshIfStale();
}
