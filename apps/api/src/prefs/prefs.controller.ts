import { Body, Controller, Delete, ForbiddenException, Get, Param, ParseUUIDPipe, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import { resolveScopeId } from "../fleet/session-scope";
import { PutHostPrefDto, PutLayoutDto } from "./dto/prefs.dto";
import { PrefsService, type LayoutView, type PrefsView } from "./prefs.service";

/** Personalisation is per session user — there is no admin path that writes
 *  someone else's layout, so nothing here takes a user id from the request. */
function userIdOf(session: UserSession): string {
  const id = session.user?.id;
  if (typeof id !== "string" || id.length === 0) throw new ForbiddenException("No user in session");
  return id;
}

@ApiTags("prefs")
@Controller("prefs")
export class PrefsController {
  constructor(private readonly prefs: PrefsService) {}

  @Get()
  read(@Session() session: UserSession): Promise<PrefsView> {
    return this.prefs.read(userIdOf(session));
  }

  @Put("layouts/:name")
  putLayout(
    @Session() session: UserSession,
    @Param("name") name: string,
    @Body() dto: PutLayoutDto,
  ): Promise<LayoutView> {
    return this.prefs.putLayout(userIdOf(session), name, dto.payload, dto.isDefault ?? false);
  }

  @Delete("layouts/:name")
  deleteLayout(@Session() session: UserSession, @Param("name") name: string): Promise<{ name: string }> {
    return this.prefs.deleteLayout(userIdOf(session), name);
  }

  @Put("hosts/:hostId")
  putHostPref(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Body() dto: PutHostPrefDto,
  ): Promise<{ hostId: string; widgets: Record<string, unknown> }> {
    return this.prefs.putHostPref(userIdOf(session), resolveScopeId(session), hostId, dto.widgets);
  }
}
