import { IsIn, IsInt, IsString, Length } from "class-validator";

import { MCP_TIERS, type McpTier } from "../mcp-tier";
import { MCP_TOKEN_EXPIRY_DAYS, type McpTokenExpiryDays } from "../user-mcp-key.crypto";

/**
 * What the dashboard may ask for when minting a fleet token.
 *
 * The expiry is an allowlist for the reason `CreateMcpKeyDto` gives — a free-form
 * number is how a credential ends up living for ten years because somebody typed an
 * extra zero — and there is deliberately no "never" among them.
 *
 * ⚠ THE TIER IS VALIDATED TWICE, AND THE SECOND TIME IS THE ONE THAT MATTERS. This
 * `@IsIn` only says the word is a tier. Whether this person may GRANT it is
 * `mcpCeilingFor(session)`, applied in the service, because it depends on who is
 * asking rather than on what they typed.
 */
export class CreateMcpTokenDto {
  @IsString()
  @Length(1, 64)
  label!: string;

  @IsInt()
  @IsIn([...MCP_TOKEN_EXPIRY_DAYS])
  expiresInDays!: McpTokenExpiryDays;

  @IsString()
  @IsIn([...MCP_TIERS])
  tier!: McpTier;
}
