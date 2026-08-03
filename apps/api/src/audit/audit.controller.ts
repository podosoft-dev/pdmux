import { Controller, ForbiddenException, Get } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import { ApiTags } from "@nestjs/swagger";
import { Repository } from "typeorm";
import { AuditLog } from "./audit-log.entity";

@ApiTags("audit")
@Controller("audit-logs")
export class AuditController {
  constructor(@InjectRepository(AuditLog) private readonly logs: Repository<AuditLog>) {}

  // Audit entries are sensitive — admins only.
  @Get()
  recent(@Session() session: UserSession): Promise<AuditLog[]> {
    if ((session.user as { role?: string | null }).role !== "admin") {
      throw new ForbiddenException("Admins only");
    }
    return this.logs.find({ order: { createdAt: "DESC" }, take: 50 });
  }
}
