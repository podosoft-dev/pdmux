import { ArrayNotEmpty, ArrayUnique, IsIn, IsInt, IsString, Length } from "class-validator";

import { MCP_KEY_EXPIRY_DAYS, MCP_KEY_SCOPES, type McpKeyExpiryDays, type McpKeyScope } from "../host-mcp-key.crypto";

/**
 * What the dashboard may ask for when minting a key.
 *
 * The expiry is an allowlist rather than a range: a free-form number is how a key
 * ends up living for ten years because somebody typed an extra zero, and the four
 * values here are exactly the ones the UI offers — so the screen and the endpoint
 * cannot drift.
 */
export class CreateMcpKeyDto {
  @IsString()
  @Length(1, 64)
  label!: string;

  @IsInt()
  @IsIn([...MCP_KEY_EXPIRY_DAYS])
  expiresInDays!: McpKeyExpiryDays;

  @ArrayNotEmpty()
  @ArrayUnique()
  @IsIn([...MCP_KEY_SCOPES], { each: true })
  scopes!: McpKeyScope[];
}
