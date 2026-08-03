/**
 * What a fleet-wide MCP token is allowed to do.
 *
 * Free of Nest and TypeORM on purpose — the same reason `flag-defaults.ts`,
 * `agent-token.crypto.ts` and `fleet-settings.ts` are: these are the rules that
 * decide who can change what, and they should be assertable without standing up a
 * module.
 *
 * ⚠ A LADDER, NOT A SET. `HostMcpKey.scopes` is a `text[]` of `read`/`write`
 * because a host key really does carry independent capabilities. A fleet token does
 * not: `admin` without `write` is not a thing anybody should be able to represent,
 * and storing a ladder as a set is exactly how it becomes representable. One column,
 * one value, compared by rank.
 */

export const MCP_TIERS = ["read", "operate", "admin"] as const;
export type McpTier = (typeof MCP_TIERS)[number];

const RANK: Record<McpTier, number> = { read: 0, operate: 1, admin: 2 };

export function isMcpTier(value: unknown): value is McpTier {
  return typeof value === "string" && (MCP_TIERS as readonly string[]).includes(value);
}

/** May a token be minted at `requested`, given the minter's own `ceiling`? */
export function tierAtMost(requested: McpTier, ceiling: McpTier): boolean {
  return RANK[requested] <= RANK[ceiling];
}

/**
 * The tier a presented token actually gets.
 *
 * ⚠ THIS IS THE FUNCTION THAT MAKES A TOKEN SAFE TO OUTLIVE ITS MOMENT. A token
 * freezes the scope it was minted in; the person's authority over that scope does
 * not. Without recomputing on every authentication, somebody removed from an
 * organization keeps whatever they were granted, for as long as the token lives.
 * Taking the minimum turns "was an admin" into "is an admin, right now".
 */
export function minTier(a: McpTier, b: McpTier): McpTier {
  return RANK[a] <= RANK[b] ? a : b;
}

/**
 * What the tool layer branches on.
 *
 * ⚠ NO TIER YIELDS A CREDENTIAL-ISSUING CAPABILITY, and there is a test that says
 * so. `host-mcp-keys.controller.ts` states the rule this enforces — "a key can never
 * mint another key" — because a credential that can mint credentials turns one leak
 * into a foothold that revoking the original does not close. `admin` here means
 * deleting hosts and changing fleet settings, and it stops there.
 */
export const MCP_CAPABILITIES = ["read", "write", "admin"] as const;
export type McpCapability = (typeof MCP_CAPABILITIES)[number];

const CAPABILITIES: Record<McpTier, readonly McpCapability[]> = {
  read: ["read"],
  operate: ["read", "write"],
  admin: ["read", "write", "admin"],
};

export function capabilitiesForTier(tier: McpTier): readonly McpCapability[] {
  return CAPABILITIES[tier];
}

export function tierAllows(tier: McpTier, capability: McpCapability): boolean {
  return CAPABILITIES[tier].includes(capability);
}

/**
 * A host key's stored scopes read on the same ladder, for display only.
 *
 * ⚠ IT CANNOT ANSWER `admin`, and that is the point rather than an omission. Host
 * keys keep the vocabulary they already have (`MCP_KEY_SCOPES`); widening that array
 * would flow through `CreateMcpKeyDto`'s `@IsIn` and make an admin-tier HOST key
 * mintable, which is a fleet-wide power on a credential scoped to one machine.
 */
export function tierOfHostScopes(scopes: readonly string[]): Extract<McpTier, "read" | "operate"> {
  return scopes.includes("write") ? "operate" : "read";
}
