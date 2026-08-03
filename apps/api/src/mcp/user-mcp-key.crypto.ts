import { randomBytes } from "node:crypto";

import { expiryFrom, sha256Hex, tokenHashEquals } from "../agents/agent-token.crypto";

/**
 * Minting and recognising the credential that reaches a whole fleet.
 *
 * Mirrors `host-mcp-key.crypto.ts` deliberately — same entropy budget, same hashing,
 * same "shape check is not the boundary" reasoning — and reuses `agent-token.crypto`
 * for the same reason that file gives: one opinion about how a secret is stored.
 */

/**
 * ⚠ A FOURTH PREFIX, AND IT MUST NOT EXTEND THE THIRD.
 *
 * `pdmux_` is a host's agent token, `pdmxe_` a one-shot enrollment code,
 * `pdmux_mcp_` a key bound to one machine, and this one reaches every host the
 * person can see. The prefixes exist so that a credential in a log or a paste says
 * what has to be revoked, and these two are the pair most worth telling apart: one
 * costs you a machine, the other costs you the fleet.
 *
 * ⚠ `pdmux_mcpu_` WOULD HAVE BEEN A BUG. It satisfies `looksLikeMcpKey`'s
 * `startsWith("pdmux_mcp_")`, so a fleet token would be looked up in the host-key
 * table, miss, and answer 401 — or worse, a later refactor would "fix" that by
 * checking both tables and quietly erase the distinction. `usr` shares no prefix
 * with `mcp`, so the two checks are exclusive in both directions.
 */
export const MCP_TOKEN_PREFIX = "pdmux_usr_";

/** Same display budget as the host key, so one table column fits both. */
const PREFIX_DISPLAY_LENGTH = MCP_TOKEN_PREFIX.length + 8;

export function mintMcpToken(): { token: string; keyHash: string; keyPrefix: string } {
  const token = `${MCP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, keyHash: hashMcpToken(token), keyPrefix: token.slice(0, PREFIX_DISPLAY_LENGTH) };
}

export function hashMcpToken(token: string): string {
  return sha256Hex(token);
}

export { tokenHashEquals };

/**
 * A cheap shape check, and the thing that makes authentication read ONE table.
 *
 * `McpAuthService` dispatches on the prefix before any query, so a presented
 * credential costs a single indexed lookup rather than one per kind. Like its
 * host-key twin this is not a security boundary — the hash lookup is.
 */
export function looksLikeMcpToken(value: string): boolean {
  return value.startsWith(MCP_TOKEN_PREFIX) && value.length >= MCP_TOKEN_PREFIX.length + 20;
}

/** For a log line or an audit target: never the whole secret. */
export function maskMcpToken(token: string): string {
  return `${MCP_TOKEN_PREFIX}…${token.slice(-4)}`;
}

/**
 * The only expiries a fleet token may be given.
 *
 * ⚠ THERE IS NO "NEVER", AND THE HOST KEY'S REASONING APPLIES HERE WITH MORE FORCE.
 * `host-mcp-key.entity.ts` made `expiresAt` NOT NULL because such a key "belongs to
 * a person's tooling, is minted in two clicks, and is the kind of secret that ends
 * up in a shell history — so it dies on its own". This credential reaches every host
 * in the scope and, at admin tier, can delete them; granting the stronger one the
 * property the weaker was denied is backwards.
 *
 * Agent tokens DO allow "never" (`agent-token.crypto.ts`) and that is not a
 * counter-example: a machine cannot renew its own credential, so an expiry there is
 * an outage with a calendar. A person re-mints on a screen they are already looking
 * at.
 *
 * ⚠ 7 IS FIRST ON PURPOSE. The request behind "can I have one that never expires"
 * is usually "I do not want to be surprised" — answered better by an afternoon-sized
 * option plus an expiring badge in the list than by an immortal credential.
 */
export const MCP_TOKEN_EXPIRY_DAYS = [7, 30, 90, 180, 365] as const;
export type McpTokenExpiryDays = (typeof MCP_TOKEN_EXPIRY_DAYS)[number];

/** Inside this window the list says so, which is what "no surprises" actually needs. */
export const MCP_TOKEN_EXPIRING_SOON_DAYS = 14;

export { expiryFrom };
