import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Token minting/hashing, kept free of Nest and TypeORM so the security-critical
 * rules can be unit-tested directly.
 */

/** Prefix so a leaked secret is greppable in logs and recognisable in a paste. */
export const AGENT_TOKEN_PREFIX = "pdmux_";

/** 32 bytes of entropy, base64url — long enough that online guessing is pointless. */
export function mintAgentToken(): { token: string; tokenHash: string } {
  const token = `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, tokenHash: hashAgentToken(token) };
}

/**
 * sha256 hex of a string. Shared with the enrollment codes (agent-enrollment.crypto.ts)
 * so both credentials are stored and compared the same way.
 *
 * sha256, NOT bcrypt/argon2. WHY: these secrets are high-entropy random, not
 * human-chosen passwords, so there is nothing for a slow hash to protect against —
 * and a token is verified on every reconnect of every host, where a deliberately
 * slow KDF would be a self-inflicted denial of service.
 */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashAgentToken(token: string): string {
  return sha256Hex(token);
}

/** Constant-time compare of two hex digests. */
export function tokenHashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Cheap shape check before touching the database on a garbage header. */
export function looksLikeAgentToken(value: string): boolean {
  return value.startsWith(AGENT_TOKEN_PREFIX) && value.length >= AGENT_TOKEN_PREFIX.length + 20;
}

/** What a UI may show about a token after creation: never the secret itself. */
export function maskAgentToken(token: string): string {
  return `${AGENT_TOKEN_PREFIX}…${token.slice(-4)}`;
}

/**
 * The only expiries a token may be GIVEN — and the value that is not in this list
 * is the default: `null`, meaning never.
 *
 * ⚠ AN ALLOW-LIST, NOT A RANGE, for the reason `host-mcp-key.crypto.ts` already
 * records: a free-form number is how a credential ends up living for ten years
 * because somebody typed an extra zero. These five are what the UI offers and what
 * the DTO accepts, so the screen and the endpoint cannot drift.
 *
 * ⚠ AND THE DEFAULT IS DELIBERATELY "NEVER", WHICH THE MCP KEY DOES NOT ALLOW. An
 * agent token belongs to a machine that goes dark when its credential lapses, and
 * the machine cannot renew itself — Tailscale disables key expiry for tagged server
 * devices for exactly this reason, because forced re-auth on a server is an outage
 * with a calendar. So expiry here is a CHOICE MADE AT ISSUE TIME: a real host takes
 * the default and is unaffected, and the short-lived agent somebody starts for one
 * afternoon dies on its own instead of retrying against the fleet forever.
 *
 * `7` heads the list because that is the case this exists for; `365` is the longest
 * a caller can ask for without saying "never" outright.
 */
export const AGENT_TOKEN_EXPIRY_DAYS = [7, 30, 90, 180, 365] as const;
export type AgentTokenExpiryDays = (typeof AGENT_TOKEN_EXPIRY_DAYS)[number];

/**
 * Days from a moment to a deadline.
 *
 * Shared with the MCP keys (`host-mcp-key.crypto.ts` re-exports it) so the two
 * credentials cannot end up with two opinions about what "90 days" means. The
 * parameter is a plain number rather than either allow-list union: the allow-list
 * is enforced where an untrusted value arrives, which is the DTO, and typing it
 * here as well would only mean the two lists have to be unioned to share one line
 * of arithmetic.
 */
export function expiryFrom(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}
