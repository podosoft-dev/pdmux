import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Length, Matches } from "class-validator";

import { AGENT_TOKEN_EXPIRY_DAYS, type AgentTokenExpiryDays } from "../agent-token.crypto";

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

export class CreateAgentTokenDto {
  /** Operator-facing name ("laptop", "ci"), so a revocation list is readable. */
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  @Matches(/\S/, { message: "name must contain a non-whitespace character" })
  name!: string;

  /**
   * Omitted means never, which is what a real host wants — see
   * `AGENT_TOKEN_EXPIRY_DAYS` for why that is the default and why the accepted
   * values are an allow-list rather than a range.
   *
   * ⚠ IT HAS TO BE DECLARED HERE EVEN THOUGH IT IS OPTIONAL. `main.ts` validates
   * with `forbidNonWhitelisted`, so a property this class does not name is a 400
   * rather than something quietly ignored — an undeclared field would make the
   * dashboard's new select fail with a validation error that says nothing about
   * expiry.
   */
  @ApiPropertyOptional({ enum: AGENT_TOKEN_EXPIRY_DAYS, description: "Days until the token stops working" })
  @IsOptional()
  @IsInt()
  @IsIn([...AGENT_TOKEN_EXPIRY_DAYS])
  expiresInDays?: AgentTokenExpiryDays;
}
