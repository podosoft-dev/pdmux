import { ApiProperty } from "@nestjs/swagger";
import { IsString } from "class-validator";

export class PutObjectDto {
  @ApiProperty({ example: "hello world" })
  @IsString()
  content!: string;
}
