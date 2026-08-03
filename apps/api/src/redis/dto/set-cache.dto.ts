import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsOptional, IsString, Min } from "class-validator";

export class SetCacheDto {
  @ApiProperty({ example: "hello" })
  @IsString()
  value!: string;

  @ApiPropertyOptional({ example: 60, description: "TTL in seconds" })
  @IsOptional()
  @IsInt()
  @Min(1)
  ttl?: number;
}
