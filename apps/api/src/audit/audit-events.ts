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

type Recorder = (entry: AuditEntry) => Promise<void>;
let recorder: Recorder | null = null;

// AuditService registers the recorder during Elysia configuration. The registry
// stays available to Better Auth hooks and background jobs.
export function setAuditRecorder(fn: Recorder): () => void {
  recorder = fn;
  return () => {
    if (recorder === fn) recorder = null;
  };
}

// Record a custom audit event from anywhere. Awaits the write; a no-op until the
// AuditService has started. Example:
//   await recordAudit({ action: "invoice.paid", actorId, targetLabel: invoice.number,
//                       metadata: { amount } });
export async function recordAudit(entry: AuditEntry): Promise<void> {
  if (recorder) await recorder(entry);
}
