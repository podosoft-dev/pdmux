import type { SQL } from "bun";
import type { AuthSession } from "../auth/auth.service";
import { auditEnabled } from "./audit-enabled";
import { setAuditRecorder, type AuditEntry } from "./audit-events";

export interface AuditLogView extends AuditEntry {
  id: string;
  createdAt: string;
}

interface AuditLogRow extends Omit<AuditLogView, "createdAt"> {
  createdAt: Date;
}

export interface AuditTarget {
  type?: string;
  id?: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

export class AuditService {
  private unregister?: () => void;

  constructor(private readonly sql: SQL) {}

  connect(): void {
    this.unregister ??= setAuditRecorder((entry) => this.record(entry));
  }

  close(): void {
    this.unregister?.();
    this.unregister = undefined;
  }

  async record(entry: AuditEntry): Promise<void> {
    try {
      const metadata = entry.metadata === undefined || entry.metadata === null
        ? null
        : JSON.stringify(entry.metadata);
      await this.sql`
        INSERT INTO "audit_logs" (
          "action", "actorId", "actorName", "actorEmail",
          "targetType", "targetId", "targetLabel", "ip", "metadata"
        ) VALUES (
          ${entry.action}, ${entry.actorId ?? null}, ${entry.actorName ?? null},
          ${entry.actorEmail ?? null}, ${entry.targetType ?? null},
          ${entry.targetId ?? null}, ${entry.targetLabel ?? null}, ${entry.ip ?? null},
          ${metadata}::jsonb
        )
      `;
    } catch {
      // Audit persistence must never break the operation it describes.
    }
  }

  async recent(limit = 50): Promise<AuditLogView[]> {
    const rows = await this.sql<AuditLogRow[]>`
      SELECT "id", "action", "actorId", "actorName", "actorEmail",
             "targetType", "targetId", "targetLabel", "ip", "metadata", "createdAt"
      FROM "audit_logs"
      ORDER BY "createdAt" DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  async recordRequest(
    action: string,
    request: Request,
    session: AuthSession,
    target: AuditTarget = {},
  ): Promise<void> {
    if (!(await auditEnabled())) return;
    await this.record({
      action,
      actorId: session.user.id,
      actorName: typeof session.user.name === "string" ? session.user.name : null,
      actorEmail: typeof session.user.email === "string" ? session.user.email : null,
      targetType: target.type ?? null,
      targetId: target.id ?? null,
      targetLabel: target.label ?? null,
      metadata: target.metadata ?? null,
      ip: request.headers.get("x-forwarded-for") ?? null,
    });
  }
}
