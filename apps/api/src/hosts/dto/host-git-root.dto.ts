import { Transform } from "class-transformer";
import { IsBoolean, IsInt, IsOptional, IsString, Length, Matches, Min } from "class-validator";

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

/**
 * ⚠ ABSOLUTE PATHS ONLY, AND THE CHECK IS HERE RATHER THAN ON THE AGENT. A
 * relative path is resolved against whatever directory the agent's service
 * manager happened to start it in — which is not a thing the person typing it can
 * see, predict, or debug from the dashboard. Refusing it at the door turns a
 * mystery into a form error.
 *
 * The length cap matches the contract's `z.string().max(1024)` so a path that
 * would fail the frame fails the request instead.
 */
export class CreateHostGitRootDto {
  @Transform(trim)
  @IsString()
  @Length(1, 1024)
  @Matches(/^\//, { message: "path must be absolute (start with /)" })
  path!: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateHostGitRootDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 1024)
  @Matches(/^\//, { message: "path must be absolute (start with /)" })
  path?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
