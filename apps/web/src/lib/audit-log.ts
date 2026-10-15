// Client for the audit-log module's cursor-paged list (GET /api/audit-logs).
// The body is an array; the cursor for the next page arrives in a header.

export type AuditLogEntry = {
  id: string;
  action: string;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  targetLabel: string | null;
  ip: string | null;
  createdAt: string;
};

export type AuditLogOrder = "asc" | "desc";

export type AuditLogFilters = {
  action: string;
  /** Exact actor email. */
  actor: string;
  /** Exact target label. */
  target: string;
};

export type AuditLogPage = {
  entries: AuditLogEntry[];
  nextCursor: string | null;
};

export const AUDIT_NEXT_CURSOR_HEADER = "x-next-cursor";

export type Fetcher = (url: string) => Promise<Response>;

export function auditLogUrl(
  filters: AuditLogFilters,
  order: AuditLogOrder,
  cursor: string | null,
  limit: number,
): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (order === "asc") params.set("order", "asc");
  if (cursor) params.set("cursor", cursor);
  for (const key of ["action", "actor", "target"] as const) {
    const value = filters[key].trim();
    if (value) params.set(key, value);
  }
  return `/api/audit-logs?${params.toString()}`;
}

export async function fetchAuditLogPage(
  fetcher: Fetcher,
  filters: AuditLogFilters,
  order: AuditLogOrder,
  cursor: string | null,
  limit: number,
): Promise<AuditLogPage> {
  const response = await fetcher(auditLogUrl(filters, order, cursor, limit));
  if (!response.ok) throw new Error(`Audit log request failed with status ${response.status}`);
  return {
    entries: (await response.json()) as AuditLogEntry[],
    nextCursor: response.headers.get(AUDIT_NEXT_CURSOR_HEADER),
  };
}

export async function fetchAuditActions(fetcher: Fetcher): Promise<string[]> {
  const response = await fetcher("/api/audit-logs/actions");
  if (!response.ok) throw new Error(`Audit action request failed with status ${response.status}`);
  return (await response.json()) as string[];
}

// A cursor-paged list has no total, so the pager learns its pages as they load:
// `cursors[n]` opens page n + 1, and `end` is set once a page comes back
// without a next cursor.
export type CursorTrail = {
  cursors: Array<string | null>;
  end: { page: number; size: number } | null;
};

export function emptyTrail(): CursorTrail {
  return { cursors: [null], end: null };
}

/** The cursor that opens `page`, or undefined when that page is not reachable yet. */
export function cursorForPage(trail: CursorTrail, page: number): string | null | undefined {
  return page >= 1 ? trail.cursors[page - 1] : undefined;
}

/** Records what loading `page` revealed about the pages after it. */
export function recordPage(
  trail: CursorTrail,
  page: number,
  size: number,
  nextCursor: string | null,
): CursorTrail {
  // An unchanged next cursor means the later pages learned earlier still line up.
  if (nextCursor !== null && trail.cursors[page] === nextCursor) return trail;
  return {
    cursors: [...trail.cursors.slice(0, page), ...(nextCursor === null ? [] : [nextCursor])],
    end: nextCursor === null ? { page, size } : null,
  };
}

/** Row count for the pager: exact once the end is known, else every reachable page as full. */
export function trailCount(trail: CursorTrail, perPage: number): number {
  return trail.end
    ? (trail.end.page - 1) * perPage + trail.end.size
    : trail.cursors.length * perPage;
}
