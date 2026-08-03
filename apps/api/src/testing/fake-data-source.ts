import type { DataSource } from "typeorm";

/**
 * A DataSource whose only job is to answer the one raw query `HostsService` makes:
 * an email address to a user id.
 *
 * WHY A FAKE RATHER THAN A REAL CONNECTION: the lookup exists because this module
 * owns no user entity — the table belongs to better-auth. A spec that wanted to
 * exercise it for real would have to stand up that library's schema to assert on a
 * single SELECT, which tests the library rather than the move.
 *
 * Unknown addresses answer with no rows, which is what "no such account" looks like
 * to the caller.
 */
export function fakeDataSource(usersByEmail: Record<string, string> = {}): DataSource {
  const lookup = new Map(Object.entries(usersByEmail).map(([email, id]) => [email.toLowerCase(), id]));
  return {
    query: async (_sql: string, parameters?: unknown[]) => {
      const email = String(parameters?.[0] ?? "").toLowerCase();
      const id = lookup.get(email);
      return id ? [{ id }] : [];
    },
  } as unknown as DataSource;
}
