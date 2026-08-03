import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from "class-validator";

/** Full ordered list of host ids. Sending the whole order (rather than a moved
 *  pair) makes the operation idempotent and immune to a lost drag event. */
export class ReorderHostsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @IsUUID("4", { each: true })
  ids!: string[];
}
