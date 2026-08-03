import { ArrayMaxSize, ArrayNotEmpty, IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

/**
 * ⚠ THE FIELD LIST IS THE CONTRACT. `main.ts` runs `ValidationPipe({ whitelist,
 * forbidNonWhitelisted })`, so a property a DTO does not declare is a 400, not a
 * silently ignored extra. A dashboard that starts sending a new field fails
 * wholesale against an older API — add the field, deploy, then send it.
 */
export class UpdateAgentDto {
  /**
   * Which build. Omitted means "the newest one published for this host's
   * platform", which is what the button in the UI sends.
   */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  version?: string;

  /**
   * Permit a version that is not newer than what the host runs (a deliberate
   * downgrade). It only relaxes the agent's own ordering check — verify-then-commit
   * and the rollback marker still apply, so this cannot skip a safety gate.
   */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

/** Cap on one batch. Above this the operator is asking for a fleet policy, not a click. */
export const MAX_FLEET_UPDATE_HOSTS = 200;

export class FleetUpdateAgentDto {
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_FLEET_UPDATE_HOSTS)
  @IsUUID("4", { each: true })
  hostIds!: string[];

  /**
   * Required here, unlike the single-host route. A bulk push must name the build
   * it is rolling out — that string is what the canary check verifies somebody has
   * already run, and "whatever is newest for each host" cannot be checked at all.
   */
  @IsString()
  @MaxLength(32)
  version!: string;
}
