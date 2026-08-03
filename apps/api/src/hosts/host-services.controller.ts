import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import { Audit } from "../audit/audit.decorator";
import { assertCanManageFleet, resolveScopeId } from "../fleet/session-scope";
import {
  CreateHostServiceDto,
  ReorderHostServicesDto,
  UpdateHostServiceDto,
} from "./dto/host-service.dto";
import type { HostService } from "./host-service.entity";
import { HostServicesService } from "./host-services.service";

const serviceTarget = (_req: unknown, result: unknown): { type: string; id?: string; label?: string } => {
  const service = result as Partial<HostService> | undefined;
  return { type: "host-service", id: service?.id, label: service?.label };
};

@ApiTags("hosts")
@Controller("hosts/:hostId/services")
export class HostServicesController {
  constructor(private readonly services: HostServicesService) {}

  @Get()
  list(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
  ): Promise<HostService[]> {
    return this.services.list(resolveScopeId(session), hostId);
  }

  @Post()
  @Audit("host.service.create", serviceTarget)
  create(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Body() dto: CreateHostServiceDto,
  ): Promise<HostService> {
    assertCanManageFleet(session);
    return this.services.create(resolveScopeId(session), hostId, dto);
  }

  @Put("reorder")
  @Audit("host.service.reorder", (_req, result) => ({
    type: "host-service",
    metadata: { order: (result as HostService[]).map((s) => s.id) },
  }))
  reorder(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Body() dto: ReorderHostServicesDto,
  ): Promise<HostService[]> {
    assertCanManageFleet(session);
    return this.services.reorder(resolveScopeId(session), hostId, dto.ids);
  }

  @Patch(":id")
  @Audit("host.service.update", serviceTarget)
  update(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateHostServiceDto,
  ): Promise<HostService> {
    assertCanManageFleet(session);
    return this.services.update(resolveScopeId(session), hostId, id, dto);
  }

  @Delete(":id")
  @Audit("host.service.delete", serviceTarget)
  remove(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ id: string; label: string }> {
    assertCanManageFleet(session);
    return this.services.remove(resolveScopeId(session), hostId, id);
  }
}
