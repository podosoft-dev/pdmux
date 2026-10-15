import { Elysia, t } from "elysia";
import type { ElysiaPlugin } from "../core/services";
import { MAX_AUDIT_PAGE_SIZE, type AuditService } from "./audit.service";

/** Carries the cursor for the next page, so the body stays a plain array. */
export const AUDIT_NEXT_CURSOR_HEADER = "x-next-cursor";

const listQuery = t.Object({
  cursor: t.Optional(t.String({ maxLength: 512 })),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: MAX_AUDIT_PAGE_SIZE, multipleOf: 1 })),
  // Not t.UnionEnum: Elysia fills an absent optional UnionEnum with its first value.
  order: t.Optional(t.Union([t.Literal("asc"), t.Literal("desc")])),
  action: t.Optional(t.String({ maxLength: 128 })),
  actor: t.Optional(t.String({ maxLength: 512 })),
  target: t.Optional(t.String({ maxLength: 512 })),
});

export function auditRoutes(
  audit: AuditService,
  requireAdmin: (request: Request) => Promise<unknown>,
): ElysiaPlugin {
  return new Elysia({ name: "podokit.audit" })
    .get("/audit-logs", async ({ request, query, set }) => {
      await requireAdmin(request);
      const page = await audit.list(query);
      if (page.nextCursor) set.headers[AUDIT_NEXT_CURSOR_HEADER] = page.nextCursor;
      return page.entries;
    }, {
      query: listQuery,
      detail: {
        tags: ["audit"],
        summary: "List audit entries",
        description:
          "Newest first unless order=asc. action, actor (email), and target (label) match exactly. " +
          "When more entries follow, the X-Next-Cursor response header holds the cursor for the next page.",
      },
    })
    .get("/audit-logs/actions", async ({ request }) => {
      await requireAdmin(request);
      return audit.actions();
    }, {
      detail: { tags: ["audit"], summary: "List the recorded audit action codes" },
    });
}
