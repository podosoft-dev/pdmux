import { describe, expect, it } from "vitest";
import { KeysetPages, listAdminSessions, revokeAdminSession } from "./sessions";

describe("listAdminSessions", () => {
  it("asks for one page with the cursor, trimmed search, and user", async () => {
    const paths: string[] = [];
    const client = {
      get: <T>(path: string): Promise<T> => {
        paths.push(path);
        return Promise.resolve({ items: [], nextCursor: null, total: 0 } as unknown as T);
      },
    };

    await listAdminSessions(client, { limit: 15, cursor: "abc", search: "  ada  ", userId: "user-1" });
    await listAdminSessions(client, { limit: 15, cursor: null, search: " " });

    expect(paths).toEqual([
      "/admin/sessions?limit=15&cursor=abc&search=ada&userId=user-1",
      "/admin/sessions?limit=15",
    ]);
  });
});

describe("revokeAdminSession", () => {
  it("revokes by id", async () => {
    const paths: string[] = [];
    const client = {
      del: <T>(path: string): Promise<T> => {
        paths.push(path);
        return Promise.resolve(undefined as unknown as T);
      },
    };

    await revokeAdminSession(client, "id/with slash");

    expect(paths).toEqual(["/admin/sessions/id%2Fwith%20slash"]);
  });
});

describe("KeysetPages", () => {
  it("offers the visited pages plus the next one", () => {
    const pages = new KeysetPages();
    expect(pages.cursorFor(1)).toBeNull();
    expect(pages.cursorFor(2)).toBeUndefined();
    expect(pages.pagerTotal(100, 15)).toBe(15);

    pages.record(1, "c2");
    pages.record(2, "c3");
    expect(pages.cursorFor(2)).toBe("c2");
    expect(pages.cursorFor(3)).toBe("c3");
    expect(pages.pagerTotal(100, 15)).toBe(45);
  });

  it("stops at the last page and never exceeds the total", () => {
    const pages = new KeysetPages();
    pages.record(1, "c2");
    pages.record(2, null);
    expect(pages.cursorFor(3)).toBeUndefined();
    expect(pages.pagerTotal(20, 15)).toBe(20);
    expect(pages.pagerTotal(0, 15)).toBe(0);
  });

  it("drops later cursors when a page is reloaded", () => {
    const pages = new KeysetPages();
    pages.record(1, "c2");
    pages.record(2, "c3");
    pages.record(1, "c2-new");
    expect(pages.cursorFor(2)).toBe("c2-new");
    expect(pages.cursorFor(3)).toBeUndefined();

    pages.reset();
    expect(pages.cursorFor(2)).toBeUndefined();
  });
});
