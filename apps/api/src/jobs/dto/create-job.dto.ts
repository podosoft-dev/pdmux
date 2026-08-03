import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class CreateJobDto {
  @ApiProperty({ example: "hello" })
  @IsString()
  @IsNotEmpty()
  text!: string;
}
