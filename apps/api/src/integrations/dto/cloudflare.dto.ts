import { Transform } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const trim = ({ value }: { value: unknown }): unknown => typeof value === "string" ? value.trim() : value;
const lower = ({ value }: { value: unknown }): unknown => typeof value === "string" ? value.trim().toLowerCase() : value;

export class DiscoverCloudflareDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  @Transform(trim)
  apiToken!: string;
}

export class PutCloudflareIntegrationDto extends DiscoverCloudflareDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Transform(trim)
  zoneId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(253)
  @Matches(HOSTNAME)
  @Transform(lower)
  baseDomain!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Transform(trim)
  accessPolicyId!: string;
}

export class CreateServiceExposureDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(253)
  @Matches(HOSTNAME)
  @Transform(lower)
  hostname!: string;

  @IsIn(["access", "public"])
  mode!: "access" | "public";

  @IsIn(["http", "https"])
  originScheme!: "http" | "https";

  @IsOptional()
  @IsBoolean()
  noTlsVerify?: boolean;

  @IsOptional()
  @IsBoolean()
  confirmPublic?: boolean;
}

export class UpdateServiceExposureDto extends CreateServiceExposureDto {}
