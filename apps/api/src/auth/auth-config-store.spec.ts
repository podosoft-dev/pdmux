import { describe, expect, test } from "bun:test";
import { auditLogAvailable } from "./auth-config-store";

describe("audit log capability", () => {
  test("stays off without the audit-log module even when switched on", () => {
    expect(auditLogAvailable(true, new Set())).toBe(false);
  });

  test("follows the switch once the audit-log module is installed", () => {
    const modules = new Set(["audit-log"]);
    expect(auditLogAvailable(true, modules)).toBe(true);
    expect(auditLogAvailable(false, modules)).toBe(false);
  });
});
