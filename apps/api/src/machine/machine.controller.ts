import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ApiKeyProtected } from "../api-key/api-key.decorator";

@ApiTags("machine")
@Controller("machine")
export class MachineController {
  // Reachable with a valid X-API-Key, no user session required.
  @ApiKeyProtected()
  @Get("ping")
  ping(): { ok: true; via: "api-key" } {
    return { ok: true, via: "api-key" };
  }
}
