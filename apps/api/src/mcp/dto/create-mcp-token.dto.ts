import { ApiProperty } from "@nestjs/swagger";
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
  @ApiProperty({ description: "How the token appears in the list, e.g. the machine it lives on" })
  @IsString()
  @Length(1, 64)
  label!: string;

  @ApiProperty({ enum: MCP_TOKEN_EXPIRY_DAYS, description: "Days until the token stops working" })
  @IsInt()
  @IsIn([...MCP_TOKEN_EXPIRY_DAYS])
  expiresInDays!: McpTokenExpiryDays;

  @ApiProperty({ enum: MCP_TIERS, description: "read | operate | admin — capped by the caller's own authority" })
  @IsString()
  @IsIn([...MCP_TIERS])
  tier!: McpTier;
}
