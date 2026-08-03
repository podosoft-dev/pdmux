import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { fromNodeHeaders } from "better-auth/node";
import type { Request } from "express";
import { type Observable, tap } from "rxjs";
import { auth } from "../auth/auth";
import { AUDIT_KEY, type AuditMeta } from "./audit.decorator";
import { AuditService } from "./audit.service";
import { auditEnabled } from "./audit-enabled";

// Records handlers explicitly marked with @Audit(...). Nothing is logged unless
// you opt a route in, so the trail stays meaningful (semantic actions, not raw
// HTTP). Auth/admin actions are recorded separately by the better-auth hook.
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<AuditMeta | undefined>(AUDIT_KEY, context.getHandler());
    if (!meta) return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    return next.handle().pipe(tap((result) => void this.log(meta, req, result)));
  }

  private async log(meta: AuditMeta, req: Request, result: unknown): Promise<void> {
    if (!(await auditEnabled())) return;
    let actorId: string | null = null;
    let actorName: string | null = null;
    let actorEmail: string | null = null;
    try {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (session?.user) {
        actorId = session.user.id;
        actorName = session.user.name ?? null;
        actorEmail = session.user.email ?? null;
      }
    } catch {
      /* unauthenticated */
    }
    const target = meta.resolve?.(req, result);
    await this.audit.record({
      action: meta.action,
      actorId,
      actorName,
      actorEmail,
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      targetLabel: target?.label ?? null,
      ip: req.ip ?? null,
      metadata: target?.metadata ?? null,
    });
  }
}
