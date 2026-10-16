import type { DatabaseProviderName } from "@podosoft/podokit-runtime";
import type { SQL } from "bun";

export const ADMIN_USERS_DEFAULT_LIMIT = 15;
export const ADMIN_USERS_MAX_LIMIT = 100;
export const ADMIN_USER_SORT_FIELDS = ["createdAt", "name", "email", "role"] as const;
export const ADMIN_USER_STATUSES = ["active", "pending", "banned"] as const;

export type AdminUserSortField = (typeof ADMIN_USER_SORT_FIELDS)[number];
export type AdminUserStatus = (typeof ADMIN_USER_STATUSES)[number];

/** A user as the admin list shows it. Credentials and sessions stay on the server. */
export interface AdminUserView {
  id: string;
  name: string;
  email: string;
  role: string | null;
  emailVerified: boolean;
  signupApproved: boolean;
  banned: boolean;
  banReason: string | null;
  banExpires: string | null;
  createdAt: string;
}

export interface AdminUserPage {
  items: AdminUserView[];
  total: number;
}

export interface AdminUserQuery {
  limit?: number;
  offset?: number;
  search?: string;
  searchField?: "email" | "name";
  role?: string;
  status?: AdminUserStatus;
  sortBy?: AdminUserSortField;
  sortDirection?: "asc" | "desc";
}

type Flag = boolean | number | null;

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string | null;
  emailVerified: Flag;
  signupApproved: Flag;
  banned: Flag;
  banReason: string | null;
  banExpires: Date | string | null;
  createdAt: Date | string;
}

// SQLite stores booleans as 0 or 1. An unset approval predates sign-up approval.
function flag(value: Flag, unset: boolean): boolean {
  return value === null ? unset : value === true || value === 1;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * Lists users for the admin console with every filter applied in one query.
 * Better Auth `listUsers` accepts a single filter, so role and status could not
 * combine there. Mutations stay on Better Auth so its permission checks and the
 * audit hooks still run.
 */
export class AdminUsersService {
  constructor(
    private readonly sql: SQL,
    private readonly provider: DatabaseProviderName,
  ) {}

  async list(query: AdminUserQuery = {}): Promise<AdminUserPage> {
    const limit = Math.min(Math.max(query.limit ?? ADMIN_USERS_DEFAULT_LIMIT, 1), ADMIN_USERS_MAX_LIMIT);
    const offset = Math.max(query.offset ?? 0, 0);
    const search = query.search?.trim() ?? "";
    const filters = (): SQL.Query<unknown> => this.sql`
      WHERE 1 = 1
      ${search ? this.searchFilter(query.searchField ?? "email", likePattern(search)) : this.sql``}
      ${query.role ? this.sql`AND (',' || u."role" || ',') LIKE ${`%,${query.role},%`}` : this.sql``}
      ${query.status ? this.statusFilter(query.status) : this.sql``}
    `;
    const [rows, totals] = await Promise.all([
      this.sql<UserRow[]>`
        SELECT u."id", u."name", u."email", u."role", u."emailVerified", u."signupApproved",
               u."banned", u."banReason", u."banExpires", u."createdAt"
        FROM "user" u
        ${filters()}
        ${this.order(query.sortBy ?? "createdAt", query.sortDirection ?? "desc")}
        LIMIT ${limit} OFFSET ${offset}
      `,
      this.sql<Array<{ total: number | string | bigint }>>`
        SELECT COUNT(*) AS "total" FROM "user" u ${filters()}
      `,
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        emailVerified: flag(row.emailVerified, false),
        signupApproved: flag(row.signupApproved, true),
        banned: flag(row.banned, false),
        banReason: row.banReason,
        banExpires: row.banExpires === null ? null : iso(row.banExpires),
        createdAt: iso(row.createdAt),
      })),
      total: Number(totals[0]?.total ?? 0),
    };
  }

  private searchFilter(field: "email" | "name", pattern: string): SQL.Query<unknown> {
    const column = field === "name" ? this.sql`u."name"` : this.sql`u."email"`;
    // SQLite LIKE ignores ASCII case; PostgreSQL needs ILIKE.
    return this.provider === "sqlite"
      ? this.sql`AND ${column} LIKE ${pattern} ESCAPE '\\'`
      : this.sql`AND ${column} ILIKE ${pattern} ESCAPE '\\'`;
  }

  private statusFilter(status: AdminUserStatus): SQL.Query<unknown> {
    switch (status) {
      case "pending":
        return this.sql`AND u."signupApproved" = FALSE`;
      case "banned":
        return this.sql`AND u."banned" = TRUE`;
      case "active":
        return this.sql`AND COALESCE(u."banned", FALSE) = FALSE AND COALESCE(u."signupApproved", TRUE) = TRUE`;
    }
  }

  private order(field: AdminUserSortField, direction: "asc" | "desc"): SQL.Query<unknown> {
    const column = {
      createdAt: this.sql`u."createdAt"`,
      name: this.sql`u."name"`,
      email: this.sql`u."email"`,
      role: this.sql`u."role"`,
    }[field];
    // The id breaks ties so offset pages neither skip nor repeat users.
    return direction === "asc"
      ? this.sql`ORDER BY ${column} ASC, u."id" ASC`
      : this.sql`ORDER BY ${column} DESC, u."id" DESC`;
  }
}
