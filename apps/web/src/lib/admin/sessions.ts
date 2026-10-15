import type { ApiClient } from "@podosoft/podokit-api-client";

/** An active session from `GET /admin/sessions`. The API never returns the session token. */
export type AdminSession = {
  id: string;
  userId: string;
  userEmail: string;
  userName: string;
  ipAddress: string | null;
  userAgent: string | null;
  impersonatedBy: string | null;
  createdAt: string;
  expiresAt: string;
};

export type AdminSessionPage = {
  items: AdminSession[];
  nextCursor: string | null;
  total: number;
};

export type AdminSessionQuery = {
  limit: number;
  cursor?: string | null;
  search?: string;
  userId?: string;
};

export function listAdminSessions(
  client: Pick<ApiClient, "get">,
  query: AdminSessionQuery,
): Promise<AdminSessionPage> {
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.cursor) params.set("cursor", query.cursor);
  const search = query.search?.trim();
  if (search) params.set("search", search);
  if (query.userId) params.set("userId", query.userId);
  return client.get<AdminSessionPage>(`/admin/sessions?${params.toString()}`);
}

/** Revokes by session id; the server looks up the token, so it never reaches the browser. */
export function revokeAdminSession(client: Pick<ApiClient, "del">, id: string): Promise<void> {
  return client.del<void>(`/admin/sessions/${encodeURIComponent(id)}`);
}

/**
 * Remembers the keyset cursor that starts each page reached so far. The API pages
 * forward only, so the DataTable pager offers the pages already visited plus the
 * next one, while the footer label still shows the full total.
 */
export class KeysetPages {
  #cursors: Array<string | null> = [null];

  reset(): void {
    this.#cursors = [null];
  }

  /** The cursor that starts `page` (1-based): `null` for the first page, `undefined` when not reached yet. */
  cursorFor(page: number): string | null | undefined {
    return this.#cursors[page - 1];
  }

  /** Records the result of loading `page`; cursors after it are stale once the page is reloaded. */
  record(page: number, nextCursor: string | null): void {
    this.#cursors.length = page;
    if (nextCursor) this.#cursors.push(nextCursor);
  }

  /** The row count to give the DataTable pager so it shows exactly the reachable pages. */
  pagerTotal(total: number, perPage: number): number {
    return Math.min(total, this.#cursors.length * perPage);
  }
}
