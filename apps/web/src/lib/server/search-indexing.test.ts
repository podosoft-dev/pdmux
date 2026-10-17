import { describe, expect, it, vi } from "vitest";
import { applySearchIndexingHeaders, shouldPreventSearchIndexing } from "./search-indexing";

// Stands in for the application's own list in the app-owned non-indexable-paths.ts.
vi.mock("./non-indexable-paths", () => ({ APP_NON_INDEXABLE_PATHS: ["/", "/projects"] }));

describe("search indexing", () => {
  it("keeps PodoKit's private paths out of search results", () => {
    expect(shouldPreventSearchIndexing("/admin/users")).toBe(true);
    expect(shouldPreventSearchIndexing("/account")).toBe(true);
    expect(shouldPreventSearchIndexing("/api/site/settings")).toBe(true);
  });

  it("adds the application's prefixes and their subpaths", () => {
    expect(shouldPreventSearchIndexing("/projects")).toBe(true);
    expect(shouldPreventSearchIndexing("/projects/a/b")).toBe(true);
    expect(shouldPreventSearchIndexing("/projects-archive")).toBe(false);
  });

  it("treats a listed root as the landing page only", () => {
    expect(shouldPreventSearchIndexing("/")).toBe(true);
    expect(shouldPreventSearchIndexing("/pricing")).toBe(false);
  });

  it("sets the header only on non-indexable responses", () => {
    expect(applySearchIndexingHeaders(new Response("ok"), "/projects/1").headers.get("x-robots-tag")).toBe(
      "noindex, nofollow",
    );
    expect(applySearchIndexingHeaders(new Response("ok"), "/pricing").headers.has("x-robots-tag")).toBe(false);
  });
});
