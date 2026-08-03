import { ApiProperty } from "@nestjs/swagger";
import { IsString } from "class-validator";

export class PublishEventDto {
  @ApiProperty({ example: "hello" })
  @IsString()
  message!: string;
}
