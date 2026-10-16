import { describe, expect, it } from "vitest";
import {
  adminUsersQuery,
  keepLatestFilter,
  listAdminUsers,
  listUsersQuery,
  type UserListState,
} from "./users";

const base: UserListState = {
  page: 1,
  perPage: 15,
  sort: null,
  search: "",
  searchField: "email",
  role: "",
  status: "",
};

describe("adminUsersQuery", () => {
  it("pages newest first by default", () => {
    expect(adminUsersQuery({ ...base, page: 3 })).toEqual({
      limit: 15,
      offset: 30,
      sortBy: "createdAt",
      sortDirection: "desc",
    });
  });

  it("sorts by a table column on the server", () => {
    expect(adminUsersQuery({ ...base, sort: { key: "name", dir: "asc" } })).toMatchObject({
      sortBy: "name",
      sortDirection: "asc",
    });
    expect(adminUsersQuery({ ...base, sort: { key: "status", dir: "asc" } })).toMatchObject({
      sortBy: "createdAt",
      sortDirection: "desc",
    });
  });

  it("searches the chosen field with the text trimmed", () => {
    expect(adminUsersQuery({ ...base, search: "  Ada@Example.COM " })).toMatchObject({
      search: "Ada@Example.COM",
      searchField: "email",
    });
    expect(adminUsersQuery({ ...base, search: "Ada", searchField: "name" })).toMatchObject({
      search: "Ada",
      searchField: "name",
    });
    expect(adminUsersQuery({ ...base, search: "   " })).not.toHaveProperty("search");
  });

  it("sends the role and status filters together", () => {
    expect(adminUsersQuery({ ...base, role: "admin", status: "active" })).toMatchObject({
      role: "admin",
      status: "active",
    });
    expect(adminUsersQuery({ ...base, status: "pending" })).toMatchObject({ status: "pending" });
    expect(adminUsersQuery({ ...base, status: "deleted" })).not.toHaveProperty("status");
    expect(adminUsersQuery(base)).not.toHaveProperty("role");
  });
});

describe("listAdminUsers", () => {
  it("asks GET /admin/users for one page", async () => {
    const paths: string[] = [];
    const client = {
      get: <T>(path: string): Promise<T> => {
        paths.push(path);
        return Promise.resolve({ items: [], total: 0 } as unknown as T);
      },
    };

    await listAdminUsers(client, adminUsersQuery({ ...base, page: 2, search: "ada", role: "admin", status: "banned" }));
    await listAdminUsers(client, adminUsersQuery(base));

    expect(paths).toEqual([
      "/admin/users?limit=15&offset=15&sortBy=createdAt&sortDirection=desc&search=ada&searchField=email&role=admin&status=banned",
      "/admin/users?limit=15&offset=0&sortBy=createdAt&sortDirection=desc",
    ]);
  });
});

// Application-owned users pages from 1.2 still import these.
describe("deprecated listUsers helpers", () => {
  it("still builds the single-filter Better Auth query", () => {
    expect(listUsersQuery({ ...base, page: 2, search: " Ada@Example.COM ", status: "banned" })).toEqual({
      limit: 15,
      offset: 15,
      sortBy: "createdAt",
      sortDirection: "desc",
      searchValue: "ada@example.com",
      searchField: "email",
      searchOperator: "contains",
      filterField: "banned",
      filterValue: true,
      filterOperator: "eq",
    });
    expect(keepLatestFilter({ role: "admin", status: "" }, { role: "admin", status: "banned" }))
      .toEqual({ role: "", status: "banned" });
  });
});
