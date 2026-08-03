import { Transform } from "class-transformer";
import { IsOptional, IsString, Length } from "class-validator";

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

/**
 * The body of `POST /agent/enroll`.
 *
 * ⚠ THE CODE TRAVELS IN THE BODY, NOT A HEADER. The web tier forwards a fixed
 * allowlist of request headers to the API (apps/web/src/lib/server/backend-proxy.ts,
 * `FORWARDED_HEADERS`), so a custom header would simply not arrive — the API would
 * see an authenticated-looking request with no credential at all.
 *
 * ⚠ THE FIELD LIST IS A CONTRACT. main.ts runs
 * `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`, so a property
 * this class does not declare is a **400**, not a silently ignored extra. A newer
 * installer that starts sending one more field therefore breaks against an older
 * API: add the field here (and deploy) before any installer sends it.
 */
export class EnrollAgentDto {
  /** Accepted in any casing, with or without dashes/spaces — canonicalised server-side. */
  @Transform(trim)
  @IsString()
  @Length(1, 128)
  code!: string;

  /**
   * What the machine says it is. Recorded in the audit entry so an operator can
   * tell whether the box that redeemed the code is the box they meant. Not
   * authoritative: the host row's os/arch/agentVersion come from the agent's
   * `hello` frame once it connects.
   */
  @Transform(trim)
  @IsOptional()
  @IsString()
  @Length(1, 255)
  hostname?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @Length(1, 64)
  os?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @Length(1, 32)
  arch?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @Length(1, 32)
  agentVersion?: string;
}
