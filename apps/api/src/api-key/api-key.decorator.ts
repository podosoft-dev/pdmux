import { applyDecorators, UseGuards } from "@nestjs/common";
import { Public } from "@thallesp/nestjs-better-auth";
import { ApiKeyGuard } from "./api-key.guard";

// Opens a route to API-key holders: skips the user-session guard and
// requires a valid X-API-Key instead. For machine/service clients.
export function ApiKeyProtected(): ReturnType<typeof applyDecorators> {
  return applyDecorators(Public(), UseGuards(ApiKeyGuard));
}
