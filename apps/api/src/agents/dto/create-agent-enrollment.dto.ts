import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional } from "class-validator";

import { AGENT_TOKEN_EXPIRY_DAYS, type AgentTokenExpiryDays } from "../agent-token.crypto";

/**
 * What an operator may choose when minting an enrollment code.
 *
 * ⚠ THE CHOICE IS RECORDED ON THE CODE, NOT ASKED FOR AT REDEMPTION. The installer
 * runs on the machine being enrolled and has no business deciding how long its own
 * credential lives — that is exactly the party that would always answer "forever".
 * So the number is picked here, by whoever is issuing, and the redemption reads it
 * off the row it is spending.
 *
 * Omitted means never, matching `POST /hosts/:id/tokens`.
 */
export class CreateAgentEnrollmentDto {
  @ApiPropertyOptional({
    enum: AGENT_TOKEN_EXPIRY_DAYS,
    description: "Days until the token this code buys stops working",
  })
  @IsOptional()
  @IsInt()
  @IsIn([...AGENT_TOKEN_EXPIRY_DAYS])
  tokenExpiresInDays?: AgentTokenExpiryDays;
}
