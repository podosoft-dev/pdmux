/**
 * Keeping the desktop signed in to its server.
 *
 * ⚠ THE SERVER DECIDES WHETHER A SESSION IS ALIVE, NOT THE EXPIRY WE WROTE DOWN AT SIGN-IN.
 * The Electron auth client stores each cookie with the expiry of the Set-Cookie it was given and
 * drops it once that moment passes. The server, however, extends the session every time the
 * desktop uses it — and those extensions are answered to the local API, which talks to the
 * server, not to this client. So the stored copy kept saying "seven days after sign-in" while the
 * session itself was days from expiring, and the first launch past that date found no cookie at
 * all and silently stayed offline (2026-10-26: Mac 9B5E offline on the server, every server host
 * offline in the app). Reading the stored cookie without its expiry lets the server answer; a
 * session that really ended comes back as 401 and the app asks to sign in again.
 */

/** The storage key `@better-auth/electron` keeps its cookie jar under (`${storagePrefix}.cookie`). */
export const COOKIE_STORAGE_KEY = "better-auth.cookie";

export interface SessionCipher {
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

/**
 * The stored cookie jar with every expiry cleared, re-encrypted the way the client stores it
 * (base64 of the cipher text). Anything unreadable is returned untouched, so a damaged or foreign
 * value fails the way it always did instead of failing here.
 */
export function withoutStoredExpiry(item: unknown, cipher: SessionCipher): unknown {
  if (typeof item !== "string" || !item) return item;
  try {
    const jar = JSON.parse(cipher.decrypt(Buffer.from(item, "base64"))) as unknown;
    if (!jar || typeof jar !== "object" || Array.isArray(jar)) return item;
    const cleared = Object.fromEntries(Object.entries(jar as Record<string, unknown>).map(([name, entry]) => [
      name,
      entry && typeof entry === "object" ? { ...(entry as Record<string, unknown>), expires: null } : entry,
    ]));
    return cipher.encrypt(JSON.stringify(cleared)).toString("base64");
  } catch {
    return item;
  }
}

/** Why a reconnect attempt failed, as far as retrying is concerned. */
export type ConnectFailure = "signed-out" | "transient";

/**
 * A 401 means the server no longer knows the session: retrying cannot help, the user has to sign
 * in. Anything else (no network yet, the server mid-deploy, a timeout) is worth another try.
 */
export function connectFailure(error: unknown): ConnectFailure {
  const status = error && typeof error === "object" && "status" in error ? (error as { status: unknown }).status : undefined;
  return status === 401 ? "signed-out" : "transient";
}

/** Delay before reconnect attempt `attempt` (0-based): 5s, 10s, 20s … capped at 5 minutes. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempt), 300_000);
}
