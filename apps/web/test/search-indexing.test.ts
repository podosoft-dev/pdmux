import { describe, expect, it } from "vitest";
import { applySearchIndexingHeaders, shouldPreventSearchIndexing } from "../src/lib/server/search-indexing";

describe("search indexing policy", () => {
  it("prevents indexing of the private dashboard root and protected routes", () => {
    expect(shouldPreventSearchIndexing("/")).toBe(true);
    expect(shouldPreventSearchIndexing("/admin/users")).toBe(true);
    expect(shouldPreventSearchIndexing("/login")).toBe(true);
  });

  it("does not treat unrelated paths as descendants of the root rule", () => {
    expect(shouldPreventSearchIndexing("/install.sh")).toBe(false);
  });

  it("adds the robots header only when the route is private", () => {
    const privateResponse = applySearchIndexingHeaders(new Response(null), "/");
    const publicResponse = applySearchIndexingHeaders(new Response(null), "/install.sh");

    expect(privateResponse.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(publicResponse.headers.has("X-Robots-Tag")).toBe(false);
  });
});
