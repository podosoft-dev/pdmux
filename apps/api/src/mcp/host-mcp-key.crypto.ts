import { randomBytes } from "node:crypto";

import { expiryFrom, sha256Hex, tokenHashEquals } from "../agents/agent-token.crypto";

/**
 * Minting and recognising the credential an AI CLI presents to the MCP endpoint.
 *
 * Free of the HTTP framework and TypeORM so the security-critical rules can be unit-tested
 * directly, exactly as `agent-token.crypto.ts` is — and it reuses that file's
 * `sha256Hex`/`tokenHashEquals` rather than growing a second opinion about how a
 * secret is stored and compared.
 */

/**
 * ⚠ A THIRD PREFIX, DELIBERATELY DISTINCT FROM THE OTHER TWO.
 *
 * `pdmux_` is a host's agent token and `pdmxe_` is a one-shot enrollment code.
 * Those travel between a host and the fleet; this one is handed to a coding CLI a
 * person runs. When one of them turns up in a log, a paste or a bug report, the
 * prefix alone says which credential leaked and therefore what has to be revoked —
 * which is the whole reason this codebase treats prefixes as a feature.
 */
export const MCP_KEY_PREFIX = "pdmux_mcp_";

/** How much of the key is kept in the clear, so a list can name a row. */
const PREFIX_DISPLAY_LENGTH = MCP_KEY_PREFIX.length + 8;

/** 32 bytes of entropy, base64url — the same budget the agent token uses. */
export function mintMcpKey(): { key: string; keyHash: string; keyPrefix: string } {
  const key = `${MCP_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, keyHash: hashMcpKey(key), keyPrefix: key.slice(0, PREFIX_DISPLAY_LENGTH) };
}

export function hashMcpKey(key: string): string {
  return sha256Hex(key);
}

export { tokenHashEquals };

/**
 * A cheap shape check before touching the database.
 *
 * It is not a security boundary — the hash lookup is. It keeps a stray Authorization
 * header (a session token, an agent token, a copy-pasted sentence) from becoming a
 * query, and it is what lets the endpoint answer "not a key of ours" without timing
 * differences that depend on rows.
 */
export function looksLikeMcpKey(value: string): boolean {
  return value.startsWith(MCP_KEY_PREFIX) && value.length >= MCP_KEY_PREFIX.length + 20;
}

/** For a log line or an audit target: never the whole secret. */
export function maskMcpKey(key: string): string {
  return `${MCP_KEY_PREFIX}…${key.slice(-4)}`;
}

/**
 * The only expiries a key may be given.
 *
 * A free-form number is how a key ends up living for ten years because somebody
 * typed an extra zero. These four are what the UI offers and what the DTO accepts,
 * so the two cannot drift.
 */
export const MCP_KEY_EXPIRY_DAYS = [30, 90, 180, 365] as const;
export type McpKeyExpiryDays = (typeof MCP_KEY_EXPIRY_DAYS)[number];

/** Read-only is the interesting one: it is what makes `run_command` refuse. */
export const MCP_KEY_SCOPES = ["read", "write"] as const;
export type McpKeyScope = (typeof MCP_KEY_SCOPES)[number];

/**
 * Re-exported rather than defined twice.
 *
 * Agent tokens grew an optional expiry after this file had one, and two copies of
 * "days to a deadline" is how the same word comes to mean two lengths. The
 * arithmetic now lives beside `sha256Hex`, which this file already borrows from
 * for the same reason.
 */
export { expiryFrom };
