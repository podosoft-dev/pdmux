import { IsBoolean, IsObject, IsOptional } from "class-validator";

export class PutLayoutDto {
  @IsObject()
  payload!: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class PutHostPrefDto {
  @IsObject()
  widgets!: Record<string, unknown>;
}
