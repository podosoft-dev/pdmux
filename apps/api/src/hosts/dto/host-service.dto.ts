import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

const PROBES = ["tcp", "http", "none"] as const;

export class CreateHostServiceDto {
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  @Matches(/\S/, { message: "label must contain a non-whitespace character" })
  label!: string;

  @IsInt()
  @Min(1)
  @Max(65_535)
  port!: number;

  @IsOptional()
  @IsIn(PROBES)
  probe?: (typeof PROBES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(512)
  path?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  urlTemplate?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateHostServiceDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  @Matches(/\S/, { message: "label must contain a non-whitespace character" })
  label?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65_535)
  port?: number;

  @IsOptional()
  @IsIn(PROBES)
  probe?: (typeof PROBES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(512)
  path?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  urlTemplate?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class ReorderHostServicesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsUUID("4", { each: true })
  ids!: string[];
}
