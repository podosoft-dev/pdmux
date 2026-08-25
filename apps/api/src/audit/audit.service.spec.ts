import { describe, expect, mock, test } from "bun:test";
import type { SQL } from "bun";
import { recordAudit } from "./audit-events";
import { AuditService } from "./audit.service";

function sqlRecorder(rows: unknown[] = []): { sql: SQL; values: unknown[][] } {
  const values: unknown[][] = [];
  const tag = mock((_strings: TemplateStringsArray, ...parameters: unknown[]) => {
    values.push(parameters);
    return Promise.resolve(rows);
  });
  return { sql: tag as unknown as SQL, values };
}

describe("AuditService", () => {
  test("writes global audit events through one recorder", async () => {
    const recorder = sqlRecorder();
    const service = new AuditService(recorder.sql);
    service.connect();
    try {
      await recordAudit({
        action: "invoice.paid",
        actorId: "user-1",
        metadata: { amount: 42 },
      });
      expect(recorder.values).toHaveLength(1);
      expect(recorder.values[0]).toContain("invoice.paid");
      expect(recorder.values[0]).toContain('{"amount":42}');
    } finally {
      service.close();
    }
  });

  test("returns recent entries with serialized timestamps", async () => {
    const recorder = sqlRecorder([{
      id: "audit-1",
      action: "auth.login",
      createdAt: new Date("2026-01-02T03:04:05.000Z"),
    }]);
    const entries = await new AuditService(recorder.sql).recent();
    expect(entries[0]?.createdAt).toBe("2026-01-02T03:04:05.000Z");
  });

  test("does not propagate persistence failures", async () => {
    const sql = mock(() => Promise.reject(new Error("database unavailable"))) as unknown as SQL;
    await expect(new AuditService(sql).record({ action: "auth.login" })).resolves.toBeUndefined();
  });
});
