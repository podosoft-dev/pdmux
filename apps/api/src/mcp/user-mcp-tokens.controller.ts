import { Body, Controller, Delete, ForbiddenException, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";

import { Audit } from "../audit/audit.decorator";
import { mcpCeilingFor, resolveScopeId } from "../fleet/session-scope";
import { CreateMcpTokenDto } from "./dto/create-mcp-token.dto";
import { MCP_TIERS, type McpTier } from "./mcp-tier";
import { MCP_TOKEN_EXPIRY_DAYS } from "./user-mcp-key.crypto";
import { UserMcpKeysService, type McpTokenView, type MintedMcpToken } from "./user-mcp-keys.service";

/** Audit metadata never carries the plaintext — only the row it belongs to. */
const tokenTarget = (_req: unknown, result: unknown): { type: string; id?: string; label?: string; metadata?: Record<string, unknown> } => {
  const token = result as Partial<McpTokenView> | undefined;
  return { type: "mcp-token", id: token?.id, label: token?.label, metadata: { tier: token?.tier } };
};

/** What the screen needs to draw the mint form honestly. */
export interface McpTokenPolicy {
  /** The strongest tier this person may grant. Tiers above it are shown DISABLED. */
  ceiling: McpTier;
  tiers: readonly McpTier[];
  expiryDays: readonly number[];
}

/**
 * Minting and revoking the credential that reaches a whole fleet.
 *
 * ⚠ THESE ROUTES ARE FOR A PERSON IN A BROWSER, NOT FOR A TOKEN — the same rule
 * `HostMcpKeysController` states, and it matters more here. A token that could mint
 * tokens would turn one leak into a foothold that revoking the original does not
 * close, and this credential reaches every host in the scope. There is deliberately
 * no MCP tool that reaches these routes, at any tier.
 *
 * ⚠ THE SCOPE COMES FROM THE SESSION, NOT FROM A PARAMETER. A person sees and
 * revokes their own tokens in the scope they are currently in; there is no path that
 * lists somebody else's.
 */
@ApiTags("account")
@Controller("account/mcp-tokens")
export class UserMcpTokensController {
  constructor(private readonly tokens: UserMcpKeysService) {}

  /**
   * ⚠ THE SERVER ANSWERS THE PERMISSION QUESTION, not the page loader. A second copy
   * of "who may grant what" in the web tier is a copy that drifts, and the drift
   * would show as a form offering a tier the API then refuses.
   */
  @Get("policy")
  policy(@Session() session: UserSession): McpTokenPolicy {
    return {
      ceiling: mcpCeilingFor(session),
      tiers: MCP_TIERS,
      expiryDays: MCP_TOKEN_EXPIRY_DAYS,
    };
  }

  @Get()
  list(@Session() session: UserSession): Promise<McpTokenView[]> {
    return this.tokens.list(resolveScopeId(session), this.userId(session));
  }

  @Post()
  @Audit("mcp.token.create", tokenTarget)
  create(@Session() session: UserSession, @Body() dto: CreateMcpTokenDto): Promise<MintedMcpToken> {
    return this.tokens.mint(resolveScopeId(session), this.userId(session), dto);
  }

  @Delete(":id")
  @Audit("mcp.token.revoke", tokenTarget)
  revoke(@Session() session: UserSession, @Param("id", ParseUUIDPipe) id: string): Promise<McpTokenView> {
    return this.tokens.revoke(resolveScopeId(session), this.userId(session), id);
  }

  /**
   * Fails closed rather than defaulting. A session with no user cannot happen behind
   * the auth guard, and a code path that forgot the guard must not read as "some
   * anonymous owner" — `resolveScopeId` refuses the same input for the same reason.
   */
  private userId(session: UserSession): string {
    const id = session.user?.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new ForbiddenException("No user for this session");
    }
    return id;
  }
}
