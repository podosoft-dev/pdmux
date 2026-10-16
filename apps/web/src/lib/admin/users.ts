import type { ApiClient } from "@podosoft/podokit-api-client";

// Builds the `GET /admin/users` query for the server-paged users table.

export type UserListSort = { key: string; dir: "asc" | "desc" };

export type UserListState = {
  page: number;
  perPage: number;
  sort: UserListSort | null;
  search: string;
  searchField: string;
  role: string;
  status: string;
};

export type AdminUserStatus = "active" | "pending" | "banned";

/** A user from `GET /admin/users`. */
export type AdminUser = {
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
};

export type AdminUserPage = { items: AdminUser[]; total: number };

export type AdminUserQuery = {
  limit: number;
  offset: number;
  sortBy: string;
  sortDirection: "asc" | "desc";
  search?: string;
  searchField?: "email" | "name";
  role?: string;
  status?: AdminUserStatus;
};

export const DEFAULT_USER_SORT: UserListSort = { key: "createdAt", dir: "desc" };

const SORTABLE_FIELDS = new Set(["name", "email", "role", "createdAt"]);
const STATUSES = new Set<string>(["active", "pending", "banned"]);

function isStatus(value: string): value is AdminUserStatus {
  return STATUSES.has(value);
}

export function adminUsersQuery(state: UserListState): AdminUserQuery {
  const sort = state.sort && SORTABLE_FIELDS.has(state.sort.key) ? state.sort : DEFAULT_USER_SORT;
  const search = state.search.trim();
  return {
    limit: state.perPage,
    offset: (Math.max(state.page, 1) - 1) * state.perPage,
    sortBy: sort.key,
    sortDirection: sort.dir,
    // The server matches case-insensitively, so the text is sent as typed.
    ...(search ? { search, searchField: state.searchField === "name" ? "name" as const : "email" as const } : {}),
    ...(state.role ? { role: state.role } : {}),
    ...(isStatus(state.status) ? { status: state.status } : {}),
  };
}

/** Reads one page; the role and status filters combine on the server. */
export function listAdminUsers(client: Pick<ApiClient, "get">, query: AdminUserQuery): Promise<AdminUserPage> {
  const params = new URLSearchParams({
    limit: String(query.limit),
    offset: String(query.offset),
    sortBy: query.sortBy,
    sortDirection: query.sortDirection,
  });
  if (query.search) {
    params.set("search", query.search);
    params.set("searchField", query.searchField ?? "email");
  }
  if (query.role) params.set("role", query.role);
  if (query.status) params.set("status", query.status);
  return client.get<AdminUserPage>(`/admin/users?${params.toString()}`);
}

// The 1.2 users page is application-owned and still imports the helpers below,
// which build a Better Auth `admin.listUsers` query. Keep them until the next
// major release so `podo update` does not break that page; new pages use
// `adminUsersQuery` and `listAdminUsers`.

/** @deprecated Use `AdminUserQuery` with `listAdminUsers`. */
export type ListUsersQuery = {
  limit: number;
  offset: number;
  sortBy: string;
  sortDirection: "asc" | "desc";
  searchValue?: string;
  searchField?: "email" | "name";
  searchOperator?: "contains";
  filterField?: "role" | "banned" | "signupApproved";
  filterValue?: string | boolean;
  filterOperator?: "eq";
};

function filterFor(role: string, status: string): Pick<ListUsersQuery, "filterField" | "filterValue" | "filterOperator"> {
  if (status === "pending") return { filterField: "signupApproved", filterValue: false, filterOperator: "eq" };
  if (status === "banned") return { filterField: "banned", filterValue: true, filterOperator: "eq" };
  if (role) return { filterField: "role", filterValue: role, filterOperator: "eq" };
  return {};
}

/** @deprecated Use `adminUsersQuery`; `listUsers` accepts only one filter. */
export function listUsersQuery(state: UserListState): ListUsersQuery {
  const sort = state.sort && SORTABLE_FIELDS.has(state.sort.key) ? state.sort : DEFAULT_USER_SORT;
  const searchField = state.searchField === "name" ? "name" : "email";
  const search = state.search.trim();
  return {
    limit: state.perPage,
    offset: (Math.max(state.page, 1) - 1) * state.perPage,
    sortBy: sort.key,
    sortDirection: sort.dir,
    ...(search
      ? {
          searchValue: searchField === "email" ? search.toLowerCase() : search,
          searchField,
          searchOperator: "contains" as const,
        }
      : {}),
    ...filterFor(state.role, state.status),
  };
}

/** @deprecated `GET /admin/users` combines the role and status filters. */
export function keepLatestFilter(
  previous: { role: string; status: string },
  next: { role: string; status: string },
): { role: string; status: string } {
  if (!next.role || !next.status) return next;
  return next.status !== previous.status ? { role: "", status: next.status } : { role: next.role, status: "" };
}
