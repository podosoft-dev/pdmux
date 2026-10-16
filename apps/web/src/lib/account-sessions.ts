import type { ApiClient } from "@podosoft/podokit-api-client";

/** One of the signed-in user's sessions from `GET /account/sessions`. The API never returns the token. */
export type AccountSession = {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
};

export type AccountSessionPage = {
  /** The session making the request, on every page. */
  current: AccountSession | null;
  /** The other sessions, newest first. */
  items: AccountSession[];
  nextCursor: string | null;
  /** Every active session, the current one included. */
  total: number;
};

export function listAccountSessions(
  client: Pick<ApiClient, "get">,
  query: { limit: number; cursor?: string | null },
): Promise<AccountSessionPage> {
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.cursor) params.set("cursor", query.cursor);
  return client.get<AccountSessionPage>(`/account/sessions?${params.toString()}`);
}

/** Revokes one of the user's own sessions by id; the server looks up the token. */
export function revokeAccountSession(client: Pick<ApiClient, "del">, id: string): Promise<void> {
  return client.del<void>(`/account/sessions/${encodeURIComponent(id)}`);
}
