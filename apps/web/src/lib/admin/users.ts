// Builds the Better Auth `admin.listUsers` query for the server-paged users table.

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

export const DEFAULT_USER_SORT: UserListSort = { key: "createdAt", dir: "desc" };

const SORTABLE_FIELDS = new Set(["name", "email", "role", "createdAt"]);

function filterFor(role: string, status: string): Pick<ListUsersQuery, "filterField" | "filterValue" | "filterOperator"> {
  if (status === "pending") return { filterField: "signupApproved", filterValue: false, filterOperator: "eq" };
  if (status === "banned") return { filterField: "banned", filterValue: true, filterOperator: "eq" };
  if (role) return { filterField: "role", filterValue: role, filterOperator: "eq" };
  return {};
}

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
          // Better Auth matches with a case-sensitive LIKE on PostgreSQL and stores
          // emails in lower case, so lower-casing makes email search case-insensitive.
          searchValue: searchField === "email" ? search.toLowerCase() : search,
          searchField,
          searchOperator: "contains" as const,
        }
      : {}),
    ...filterFor(state.role, state.status),
  };
}

/**
 * `listUsers` accepts one filter, so the role and status selects are mutually
 * exclusive: when both hold a value, the one that just changed wins.
 */
export function keepLatestFilter(
  previous: { role: string; status: string },
  next: { role: string; status: string },
): { role: string; status: string } {
  if (!next.role || !next.status) return next;
  return next.status !== previous.status ? { role: "", status: next.status } : { role: next.role, status: "" };
}
