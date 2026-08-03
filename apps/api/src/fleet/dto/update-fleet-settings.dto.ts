import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

export class UpdateFleetSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3600)
  heartbeatSec?: number;

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(86_400)
  gitIntervalSec?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(1024, { each: true })
  gitRoots?: string[];

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(2000)
  gitLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  gitDetailBudget?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  usageProviders?: string[];

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(3600)
  usageIntervalSec?: number;

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(10_000)
  probeTimeoutMs?: number;

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(2000)
  statusFileCap?: number;

  @IsOptional()
  @IsInt()
  @Min(200)
  @Max(20_000)
  bodyMaxChars?: number;

  @IsOptional()
  @IsInt()
  @Min(4096)
  @Max(4_000_000)
  terminalBufferBytes?: number;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(3600)
  metricStepSec?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  metricRetentionDays?: number;

  // `Min(0)`, not `Min(1)`: 0 is how an operator turns automatic host removal
  // back OFF, and rejecting it would leave a fleet that opted in with no way out
  // through the API that opted it in.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  staleHostRetentionDays?: number;

  // Whether this fleet accepts fleet-wide MCP tokens. Host-scoped keys are
  // unaffected. Off by default — see the field's comment in fleet-settings.ts.
  @IsOptional()
  @IsBoolean()
  mcpUserTokens?: boolean;
}
