import { Body, Controller, Get, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import { Audit } from "../audit/audit.decorator";
import { UpdateFleetSettingsDto } from "./dto/update-fleet-settings.dto";
import { FleetSettingsService } from "./fleet-settings.service";
import type { FleetSettings } from "./fleet-settings";
import { assertCanManageFleet, resolveScopeId } from "./session-scope";

@ApiTags("fleet")
@Controller("fleet/settings")
export class FleetSettingsController {
  constructor(private readonly settings: FleetSettingsService) {}

  @Get()
  read(@Session() session: UserSession): Promise<FleetSettings> {
    return this.settings.resolve(resolveScopeId(session));
  }

  @Put()
  @Audit("fleet.settings.update", (_req, result) => ({
    type: "fleet-settings",
    metadata: { settings: result as Record<string, unknown> },
  }))
  update(
    @Session() session: UserSession,
    @Body() dto: UpdateFleetSettingsDto,
  ): Promise<FleetSettings> {
    assertCanManageFleet(session);
    return this.settings.update(resolveScopeId(session), dto);
  }
}
