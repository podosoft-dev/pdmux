import { SetMetadata } from "@nestjs/common";
import type { Request } from "express";

export const AUDIT_KEY = "podokit:audit";

// Optionally derive the target (and extra metadata) from the request + handler
// result, e.g. (req, result) => ({ type: "todo", id: result.id, label: result.title }).
export type AuditTarget = {
  type?: string;
  id?: string;
  label?: string;
  metadata?: Record<string, unknown>;
};
export type AuditMeta = {
  action: string;
  resolve?: (req: Request, result: unknown) => AuditTarget | undefined;
};

// Mark a controller handler to be audited under a semantic action code:
//   @Audit("todo.create", (_req, todo) => ({ type: "todo", id: todo.id, label: todo.title }))
export function Audit(action: string, resolve?: AuditMeta["resolve"]): MethodDecorator {
  return SetMetadata(AUDIT_KEY, { action, resolve } satisfies AuditMeta);
}
