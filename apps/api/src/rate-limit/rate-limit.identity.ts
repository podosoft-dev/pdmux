import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ApiKeyVerifier } from "../api-key/api-key-verifier";
import type { ServiceKey, ServiceRegistry } from "../core/services";

export abstract class RateLimitIdentityExtension {
  abstract validatedApiKeyId(
    request: Request,
    rawApiKey: string,
  ): Promise<string | undefined>;
}

export const RATE_LIMIT_IDENTITY_EXTENSION = Symbol(
  "rate-limit-identity-extension",
) as ServiceKey<RateLimitIdentityExtension>;

// Better Auth's session cookie. It adds the __Secure- prefix when BETTER_AUTH_URL
// uses HTTPS; either name only counts when its signature verifies.
const SESSION_COOKIE_NAMES = [
  "__Secure-better-auth.session_token",
  "better-auth.session_token",
] as const;

// better-call signs cookies as `${token}.${base64(HMAC-SHA256(secret, token))}` and
// accepts only the padded 44-character standard base64 signature.
const SIGNATURE = /^[A-Za-z0-9+/]{43}=$/;

type TrackerKind = "user" | "session" | "api-key" | "ip";

function stableDigest(kind: TrackerKind, value: string): string {
  return createHash("sha256")
    .update("podokit-rate-limit-v1", "utf8")
    .update("\0")
    .update(kind, "utf8")
    .update("\0")
    .update(value, "utf8")
    .digest("hex");
}

function tracker(kind: TrackerKind, value: string): string {
  return `${kind}:${stableDigest(kind, value)}`;
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cookieValue(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1 || pair.slice(0, separator).trim() !== name) continue;
    const value = pair.slice(separator + 1).trim();
    return decodeComponent(value.startsWith('"') ? value.slice(1, -1) : value);
  }
  return undefined;
}

function bearerValue(header: string | null): string | undefined {
  if (!header || header.slice(0, 7).toLowerCase() !== "bearer ") return undefined;
  const value = header.slice(7).trim();
  return value.includes("%") ? decodeComponent(value) : value;
}

export function verifiedSessionToken(
  signedValue: string,
  secret: string,
): string | undefined {
  const separator = signedValue.lastIndexOf(".");
  if (separator < 1) return undefined;
  const token = signedValue.slice(0, separator);
  const signature = signedValue.slice(separator + 1);
  if (!SIGNATURE.test(signature)) return undefined;
  const expected = createHmac("sha256", secret).update(token, "utf8").digest();
  const provided = Buffer.from(signature, "base64");
  return provided.length === expected.length && timingSafeEqual(provided, expected)
    ? token
    : undefined;
}

/** The most sessions one API process remembers; the oldest is forgotten first. */
const MAX_SESSION_USERS = 10_000;

/**
 * The users of the sessions this API process has resolved, so the limiter can
 * count a signed-in caller per user without a session lookup of its own. Each
 * entry lasts until its session expires, and is refreshed whenever the session
 * is resolved again. A signed-out or revoked session keeps its entry: it only
 * decides which counter its requests use, never whether they are allowed.
 */
export class SessionUsers {
  private readonly users = new Map<string, { userId: string; expiresAt: number }>();

  constructor(
    private readonly maxEntries = MAX_SESSION_USERS,
    private readonly now: () => number = Date.now,
  ) {}

  remember(sessionToken: string, userId: string, expiresAt: Date): void {
    const key = stableDigest("session", sessionToken);
    this.users.delete(key);
    if (!(expiresAt.getTime() > this.now())) return;
    this.users.set(key, { userId, expiresAt: expiresAt.getTime() });
    if (this.users.size > this.maxEntries) {
      const oldest = this.users.keys().next().value;
      if (oldest !== undefined) this.users.delete(oldest);
    }
  }

  userOf(sessionToken: string): string | undefined {
    const key = stableDigest("session", sessionToken);
    const entry = this.users.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.users.delete(key);
      return undefined;
    }
    return entry.userId;
  }
}

export class RateLimitIdentity {
  constructor(
    private readonly configuredApiKeys: ApiKeyVerifier,
    private readonly services: ServiceRegistry,
    private readonly sessionSecret: string | undefined,
    private readonly sessionUsers: SessionUsers = new SessionUsers(),
  ) {}

  /** clientAddress is the address the API resolved behind its trusted proxies. */
  async resolve(request: Request, clientAddress: string | undefined): Promise<string> {
    const rawApiKey = request.headers.get("x-api-key");
    if (rawApiKey) {
      if (this.configuredApiKeys.isValid(rawApiKey)) return tracker("api-key", rawApiKey);
      const extension = this.services.tryResolve(RATE_LIMIT_IDENTITY_EXTENSION);
      const additionalIdentity = await extension?.validatedApiKeyId(request, rawApiKey);
      if (additionalIdentity) return tracker("api-key", additionalIdentity);
    }

    const sessionToken = this.sessionToken(request.headers);
    if (sessionToken) {
      const userId = this.sessionUsers.userOf(sessionToken);
      return userId === undefined ? tracker("session", sessionToken) : tracker("user", userId);
    }

    return tracker("ip", clientAddress ?? "unknown");
  }

  // Only the signature is checked: resolving the session would cost a database
  // read on every request. Once the API has resolved the session for a request,
  // SessionUsers maps it to its user's counter; until then, and for a revoked or
  // expired token, it keeps a counter of its own. A value without a valid
  // signature falls back to the client address.
  private sessionToken(headers: Headers): string | undefined {
    if (!this.sessionSecret) return undefined;
    const cookies = headers.get("cookie");
    const candidates = [
      bearerValue(headers.get("authorization")),
      ...SESSION_COOKIE_NAMES.map((name) => cookieValue(cookies, name)),
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const token = verifiedSessionToken(candidate, this.sessionSecret);
      if (token) return token;
    }
    return undefined;
  }
}
