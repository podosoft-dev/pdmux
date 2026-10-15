import { describe, expect, it } from "vitest";
import {
  auditLogUrl,
  cursorForPage,
  emptyTrail,
  fetchAuditLogPage,
  recordPage,
  trailCount,
} from "./audit-log";

const none = { action: "", actor: "", target: "" };

describe("auditLogUrl", () => {
  it("sends only the filters that are set", () => {
    expect(auditLogUrl(none, "desc", null, 15)).toBe("/api/audit-logs?limit=15");
    expect(auditLogUrl({ action: "user.ban", actor: " a@example.com ", target: "" }, "asc", "abc", 15))
      .toBe("/api/audit-logs?limit=15&order=asc&cursor=abc&action=user.ban&actor=a%40example.com");
  });
});

describe("fetchAuditLogPage", () => {
  it("reads the entries and the next cursor header", async () => {
    const fetcher = async (): Promise<Response> =>
      new Response(JSON.stringify([{ id: "1" }]), { headers: { "x-next-cursor": "next" } });
    await expect(fetchAuditLogPage(fetcher, none, "desc", null, 15)).resolves.toEqual({
      entries: [{ id: "1" }],
      nextCursor: "next",
    });
  });

  it("fails on an error status", async () => {
    const fetcher = async (): Promise<Response> => new Response("{}", { status: 403 });
    await expect(fetchAuditLogPage(fetcher, none, "desc", null, 15)).rejects.toThrow("403");
  });
});

describe("cursor trail", () => {
  it("reaches one page past the last one loaded until the end appears", () => {
    let trail = emptyTrail();
    expect(cursorForPage(trail, 1)).toBeNull();
    expect(cursorForPage(trail, 2)).toBeUndefined();

    trail = recordPage(trail, 1, 15, "c2");
    expect(cursorForPage(trail, 2)).toBe("c2");
    expect(trailCount(trail, 15)).toBe(30);

    trail = recordPage(trail, 2, 15, "c3");
    trail = recordPage(trail, 3, 4, null);
    expect(trail.cursors).toEqual([null, "c2", "c3"]);
    expect(trailCount(trail, 15)).toBe(34);
  });

  it("keeps later pages when an earlier page still leads to them", () => {
    let trail = recordPage(recordPage(emptyTrail(), 1, 15, "c2"), 2, 15, "c3");
    trail = recordPage(trail, 1, 15, "c2");
    expect(cursorForPage(trail, 3)).toBe("c3");
  });

  it("forgets later pages when new entries shift an earlier page", () => {
    let trail = recordPage(recordPage(emptyTrail(), 1, 15, "c2"), 2, 3, null);
    trail = recordPage(trail, 1, 15, "c2-shifted");
    expect(trail).toEqual({ cursors: [null, "c2-shifted"], end: null });
  });

  it("counts an empty first page as no rows", () => {
    expect(trailCount(recordPage(emptyTrail(), 1, 0, null), 15)).toBe(0);
  });
});
