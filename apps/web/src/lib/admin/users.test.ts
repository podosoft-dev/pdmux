import { describe, expect, it } from "vitest";
import { keepLatestFilter, listUsersQuery, type UserListState } from "./users";

const base: UserListState = {
  page: 1,
  perPage: 15,
  sort: null,
  search: "",
  searchField: "email",
  role: "",
  status: "",
};

describe("listUsersQuery", () => {
  it("pages newest first by default", () => {
    expect(listUsersQuery({ ...base, page: 3 })).toEqual({
      limit: 15,
      offset: 30,
      sortBy: "createdAt",
      sortDirection: "desc",
    });
  });

  it("sorts by a table column on the server", () => {
    expect(listUsersQuery({ ...base, sort: { key: "name", dir: "asc" } })).toMatchObject({
      sortBy: "name",
      sortDirection: "asc",
    });
    expect(listUsersQuery({ ...base, sort: { key: "status", dir: "asc" } })).toMatchObject({
      sortBy: "createdAt",
      sortDirection: "desc",
    });
  });

  it("searches email case-insensitively and names as typed", () => {
    expect(listUsersQuery({ ...base, search: "  Ada@Example.COM " })).toMatchObject({
      searchValue: "ada@example.com",
      searchField: "email",
      searchOperator: "contains",
    });
    expect(listUsersQuery({ ...base, search: "Ada", searchField: "name" })).toMatchObject({
      searchValue: "Ada",
      searchField: "name",
    });
    expect(listUsersQuery({ ...base, search: "   " })).not.toHaveProperty("searchValue");
  });

  it("maps the role and status filters to the single server filter", () => {
    expect(listUsersQuery({ ...base, role: "admin" })).toMatchObject({
      filterField: "role",
      filterValue: "admin",
      filterOperator: "eq",
    });
    expect(listUsersQuery({ ...base, status: "pending" })).toMatchObject({
      filterField: "signupApproved",
      filterValue: false,
    });
    expect(listUsersQuery({ ...base, status: "banned" })).toMatchObject({
      filterField: "banned",
      filterValue: true,
    });
    expect(listUsersQuery(base)).not.toHaveProperty("filterField");
  });
});

describe("keepLatestFilter", () => {
  it("keeps whichever filter changed last", () => {
    expect(keepLatestFilter({ role: "admin", status: "" }, { role: "admin", status: "banned" }))
      .toEqual({ role: "", status: "banned" });
    expect(keepLatestFilter({ role: "", status: "banned" }, { role: "user", status: "banned" }))
      .toEqual({ role: "user", status: "" });
    expect(keepLatestFilter({ role: "", status: "" }, { role: "user", status: "" }))
      .toEqual({ role: "user", status: "" });
  });
});
