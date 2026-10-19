import { Transform, Type } from "class-transformer";
import { VM_ACTIONS, type VmAction } from "../vm-provider";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";

const trim = ({ value }: { value: unknown }): unknown => typeof value === "string" ? value.trim() : value;
const blankToNull = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? (value.trim() === "" ? null : value.trim()) : value;

/** A Proxmox node, storage, pool or tag name: letters, digits and `._-`. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
/** `user@realm!tokenid` — the id half of a Proxmox API token. */
const TOKEN_ID = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z0-9._-]+$/;
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/?$/;
/** Where a new machine reaches pdmux. Plain HTTP is allowed: it may be a private network. */
const ENROLL_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~\/-]*)?$/;
/** A client-chosen key, so a retried create makes one machine. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;

export class VmProviderDto {
  @IsIn(["proxmox"])
  kind!: "proxmox";

  @IsString() @IsNotEmpty() @MaxLength(64) @Matches(NAME) @Transform(trim)
  name!: string;

  @IsString() @Matches(HTTPS_URL) @MaxLength(255) @Transform(trim)
  baseUrl!: string;

  @IsString() @Matches(TOKEN_ID) @MaxLength(128) @Transform(trim)
  tokenId!: string;

  @IsString() @IsNotEmpty() @MaxLength(512) @Transform(trim)
  tokenSecret!: string;

  @IsOptional() @ValidateIf((_o, value) => value !== null) @IsString() @MaxLength(16_384) @Transform(blankToNull)
  caCertificate: string | null = null;

  @IsOptional() @ValidateIf((_o, value) => value !== null) @IsString() @Matches(NAME) @Transform(blankToNull)
  defaultNode: string | null = null;

  @IsOptional() @ValidateIf((_o, value) => value !== null) @IsString() @Matches(NAME) @Transform(blankToNull)
  defaultTemplateNode: string | null = null;

  @IsOptional() @ValidateIf((_o, value) => value !== null) @Type(() => Number) @IsInt() @Min(100) @Max(999_999_999)
  defaultTemplateVmid: number | null = null;

  @IsOptional() @ValidateIf((_o, value) => value !== null) @IsString() @Matches(NAME) @Transform(blankToNull)
  defaultStorage: string | null = null;

  @IsOptional() @ValidateIf((_o, value) => value !== null) @IsString() @Matches(NAME) @Transform(blankToNull)
  defaultPool: string | null = null;

  @Type(() => Number) @IsInt() @Min(100) @Max(999_999_999)
  vmidMin!: number;

  @Type(() => Number) @IsInt() @Min(100) @Max(999_999_999)
  vmidMax!: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(128)
  defaultCores = 2;

  @IsOptional() @Type(() => Number) @IsInt() @Min(512) @Max(1_048_576)
  defaultMemoryMb = 4096;

  @IsOptional() @IsBoolean()
  fullClone = false;

  @IsOptional() @ValidateIf((_o, value) => value !== null) @IsString() @Matches(NAME) @Transform(blankToNull)
  sleepRequiresTag: string | null = null;

  @IsOptional() @ValidateIf((_o, value) => value !== null) @IsString() @Matches(NAME) @Transform(blankToNull)
  backupBeforeSleep: string | null = null;

  @IsOptional() @ValidateIf((_o, value) => value !== null) @IsString() @Matches(ENROLL_URL) @MaxLength(255) @Transform(blankToNull)
  enrollUrl: string | null = null;
}

/** Every field optional; a missing or blank `tokenSecret` keeps the stored one. */
export class UpdateVmProviderDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(64) @Matches(NAME) @Transform(trim)
  name?: string;

  @IsOptional() @IsString() @Matches(HTTPS_URL) @MaxLength(255) @Transform(trim)
  baseUrl?: string;

  @IsOptional() @IsString() @Matches(TOKEN_ID) @MaxLength(128) @Transform(trim)
  tokenId?: string;

  @IsOptional() @IsString() @MaxLength(512) @Transform(trim)
  tokenSecret?: string;

  @IsOptional() @ValidateIf((_o, value) => value !== null) @IsString() @MaxLength(16_384) @Transform(blankToNull)
  caCertificate?: string | null;

  @IsOptional() @ValidateIf((_o, value) => value !== null) @IsString() @Matches(NAME) @Transform(blankToNull)
  defaultNode?: string | null;

  @IsOptional() @ValidateIf((_o, value) => value !== null) @IsString() @Matches(NAME) @Transform(blankToNull)
  defaultTemplateNode?: string | null;

  @IsOptional() @ValidateIf((_o, value) => value !== null) @Type(() => Number) @IsInt() @Min(100) @Max(999_999_999)
  defaultTemplateVmid?: number | null;

  @IsOptional() @ValidateIf((_o, value) => value !== null) @IsString() @Matches(NAME) @Transform(blankToNull)
  defaultStorage?: string | null;

  @IsOptional() @ValidateIf((_o, value) => value !== null) @IsString() @Matches(NAME) @Transform(blankToNull)
  defaultPool?: string | null;

  @IsOptional() @Type(() => Number) @IsInt() @Min(100) @Max(999_999_999)
  vmidMin?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(100) @Max(999_999_999)
  vmidMax?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(128)
  defaultCores?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(512) @Max(1_048_576)
  defaultMemoryMb?: number;

  @IsOptional() @IsBoolean()
  fullClone?: boolean;

  @IsOptional() @ValidateIf((_o, value) => value !== null) @IsString() @Matches(NAME) @Transform(blankToNull)
  sleepRequiresTag?: string | null;

  @IsOptional() @ValidateIf((_o, value) => value !== null) @IsString() @Matches(NAME) @Transform(blankToNull)
  backupBeforeSleep?: string | null;

  @IsOptional() @ValidateIf((_o, value) => value !== null) @IsString() @Matches(ENROLL_URL) @MaxLength(255) @Transform(blankToNull)
  enrollUrl?: string | null;
}

export class LinkHostVmDto {
  @IsString() @IsNotEmpty() @MaxLength(64)
  providerId!: string;

  @IsString() @Matches(NAME) @Transform(trim)
  node!: string;

  @Type(() => Number) @IsInt() @Min(100) @Max(999_999_999)
  vmid!: number;
}

export class PowerVmDto {
  @IsIn([...VM_ACTIONS])
  action!: VmAction;
}

/** A machine to create from a template, and the host it becomes. Sizes fall back to the provider's defaults. */
export class CreateVmDto {
  @IsString() @IsNotEmpty() @MaxLength(64)
  providerId!: string;

  /** The host's label, as `POST /hosts` takes it; the machine's name is derived from it. */
  @Transform(trim) @IsString() @Length(1, 64) @Matches(/\S/, { message: "label must contain a non-whitespace character" })
  label!: string;

  @IsOptional() @ValidateIf((_o, value) => value !== null) @IsString() @Matches(NAME) @Transform(blankToNull)
  templateNode: string | null = null;

  @IsOptional() @ValidateIf((_o, value) => value !== null) @Type(() => Number) @IsInt() @Min(100) @Max(999_999_999)
  templateVmid: number | null = null;

  @IsOptional() @ValidateIf((_o, value) => value !== null) @Type(() => Number) @IsInt() @Min(1) @Max(128)
  cores: number | null = null;

  @IsOptional() @ValidateIf((_o, value) => value !== null) @Type(() => Number) @IsInt() @Min(512) @Max(1_048_576)
  memoryMb: number | null = null;

  @IsString() @Matches(IDEMPOTENCY_KEY)
  idempotencyKey!: string;
}

/** The machine's name, typed again: deleting it destroys its disks. */
export class DeleteVmDto {
  @IsString() @IsNotEmpty() @MaxLength(128)
  confirmName!: string;
}
