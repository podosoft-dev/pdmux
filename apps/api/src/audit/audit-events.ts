// One audit pipeline for the whole app. Better Auth hooks and application code
// record through here, so all entries
// share the actor/action/target shape and one write path (audit_logs).

export type AuditEntry = {
  // Stable semantic action code, e.g. "user.create", "invoice.paid".
  action: string;
  actorId?: string | null;
  actorName?: string | null;
  actorEmail?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown> | null;
};

export interface AuditRecorder {
  record(entry: AuditEntry): Promise<void>;
  recordLater(entry: AuditEntry): void;
}

let recorder: AuditRecorder | null = null;

// AuditService registers the recorder during Elysia configuration. The registry
// stays available to Better Auth hooks and background jobs.
export function setAuditRecorder(next: AuditRecorder): () => void {
  recorder = next;
  return () => {
    if (recorder === next) recorder = null;
  };
}

// Record a custom audit event from anywhere. Awaits the write; a no-op until the
// AuditService has started or while the admin toggle is off. Example:
//   await recordAudit({ action: "invoice.paid", actorId, targetLabel: invoice.number,
//                       metadata: { amount } });
export async function recordAudit(entry: AuditEntry): Promise<void> {
  if (recorder) await recorder.record(entry);
}

// Queue a high-volume, non-security event and return at once. Queued entries are
// written in batches within about 250 ms and on shutdown; a crash loses whatever
// is still queued. Keep auth.*, user.*, and other security events on recordAudit().
//   recordAuditLater({ action: "comment.create", actorId, targetId: comment.id });
export function recordAuditLater(entry: AuditEntry): void {
  recorder?.recordLater(entry);
}
