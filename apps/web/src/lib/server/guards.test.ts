import { describe, expect, it, vi } from "vitest";

// Stands in for the application's own list in the app-owned public-paths.ts.
vi.mock("./public-paths", () => ({ APP_PUBLIC_PATHS: ["/pricing", "/robots.txt"] }));

const { isPublicPath } = await import("./guards");

describe("isPublicPath", () => {
  it("keeps the sign-in flow and the landing page public", () => {
    expect(isPublicPath("/")).toBe(true);
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/reset-password/token")).toBe(true);
    expect(isPublicPath("/admin")).toBe(false);
    expect(isPublicPath("/account")).toBe(false);
  });

  it("adds the application's public prefixes and their subpaths", () => {
    expect(isPublicPath("/pricing")).toBe(true);
    expect(isPublicPath("/pricing/teams")).toBe(true);
    expect(isPublicPath("/robots.txt")).toBe(true);
    expect(isPublicPath("/pricingx")).toBe(false);
  });
});
