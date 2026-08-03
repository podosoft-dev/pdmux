import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, Length } from "class-validator";

/**
 * Where a host is going.
 *
 * ⚠ AN EMAIL, NOT A USER ID. The id of another account is not on any screen and
 * cannot be checked by the person typing it; an address is the thing they already
 * know and can read back. The server resolves it to that account's own scope.
 */
export class MoveHostDto {
  @ApiProperty({ description: "Email address of the account to move this host to" })
  @IsEmail()
  @Length(3, 254)
  targetEmail!: string;
}
