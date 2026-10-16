import { describe, expect, it, vi } from "vitest";

// Stands in for the application's own list in the app-owned asset-paths.ts.
vi.mock("./asset-paths", () => ({ APP_ASSET_PATHS: ["/docs", "/feed.xml"] }));

const { needsRuntimeContext, prefersHtml } = await import("./runtime-context");

const NAVIGATION = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const IMAGE = "image/avif,image/webp,image/apng,*/*;q=0.8";

interface RequestOptions {
  routeId?: string | null;
  method?: string;
  headers?: Record<string, string>;
  isDataRequest?: boolean;
  isRemoteRequest?: boolean;
}

function request(path: string, options: RequestOptions = {}) {
  const url = new URL(path, "http://app.localhost");
  return {
    url,
    route: { id: options.routeId === undefined ? url.pathname : options.routeId },
    request: new Request(url, { method: options.method ?? "GET", headers: options.headers }),
    isDataRequest: options.isDataRequest ?? false,
    isRemoteRequest: options.isRemoteRequest ?? false,
  };
}

describe("needsRuntimeContext", () => {
  it("loads the session and site settings for pages and their data", () => {
    expect(needsRuntimeContext(request("/account", { headers: { accept: NAVIGATION } }))).toBe(true);
    expect(needsRuntimeContext(request("/account", { headers: { accept: "*/*" } }))).toBe(true);
    expect(needsRuntimeContext(request("/account", { isDataRequest: true }))).toBe(true);
  });

  it("loads them for an unmatched route because the 404 page renders the root layout", () => {
    // Without the session a signed-in visitor was sent to /login, which sent
    // them straight back: a redirect loop on every missing page.
    expect(
      needsRuntimeContext(
        request("/missing", { routeId: null, headers: { accept: NAVIGATION, "sec-fetch-dest": "document" } }),
      ),
    ).toBe(true);
    expect(needsRuntimeContext(request("/missing", { routeId: null, headers: { accept: "*/*" } }))).toBe(true);
    expect(needsRuntimeContext(request("/missing", { routeId: null, isDataRequest: true }))).toBe(true);
  });

  it("skips them for a missing subresource that SvelteKit answers without a layout", () => {
    for (const destination of ["image", "script", "style", "font"]) {
      expect(
        needsRuntimeContext(request("/missing.png", { routeId: null, headers: { "sec-fetch-dest": destination } })),
      ).toBe(false);
    }
  });

  it("skips them for the backend proxy", () => {
    expect(needsRuntimeContext(request("/api", { routeId: "/api/[...path]" }))).toBe(false);
    expect(needsRuntimeContext(request("/api/site/settings", { routeId: "/api/[...path]" }))).toBe(false);
    expect(needsRuntimeContext(request("/api/auth/get-session", { routeId: "/api/auth/[...all]" }))).toBe(false);
    expect(needsRuntimeContext(request("/apiary", { headers: { accept: NAVIGATION } }))).toBe(true);
  });

  it("skips them while prerendering", () => {
    expect(needsRuntimeContext(request("/pricing", { headers: { accept: NAVIGATION } }), { building: true })).toBe(false);
  });

  it("loads them for remote functions, which may read the session without a route", () => {
    expect(needsRuntimeContext(request("/_app/remote/abc/list", { routeId: null, isRemoteRequest: true }))).toBe(true);
  });

  it("skips them when an endpoint under an application asset path answers", () => {
    const files = { page: false, endpoint: true };
    expect(
      needsRuntimeContext(
        request("/docs/guide/diagram.png", { routeId: "/docs/[...path]", headers: { accept: IMAGE, "sec-fetch-dest": "image" } }),
        { route: files },
      ),
    ).toBe(false);
    // Opening a file in a tab is a navigation, but no page renders.
    expect(
      needsRuntimeContext(
        request("/docs/manual.pdf", { routeId: "/docs/[...path]", headers: { accept: NAVIGATION, "sec-fetch-dest": "document" } }),
        { route: files },
      ),
    ).toBe(false);
    expect(needsRuntimeContext(request("/feed.xml", { headers: { accept: "application/rss+xml" } }), { route: files })).toBe(false);
    expect(needsRuntimeContext(request("/documents", { headers: { accept: "*/*" } }), { route: files })).toBe(true);
  });

  it("keeps them when a page under an application asset path answers", () => {
    const page = { page: true, endpoint: false };
    expect(needsRuntimeContext(request("/docs", { headers: { accept: "*/*" } }), { route: page })).toBe(true);
    expect(needsRuntimeContext(request("/docs", { headers: { accept: NAVIGATION } }), { route: page })).toBe(true);
  });

  it("follows SvelteKit's page or endpoint choice when an asset route has both", () => {
    const both = { page: true, endpoint: true };
    const docs = (options: RequestOptions) =>
      needsRuntimeContext(request("/docs/intro", { routeId: "/docs/[slug]", ...options }), { route: both });
    expect(docs({ headers: { accept: NAVIGATION } })).toBe(true);
    expect(docs({ isDataRequest: true })).toBe(true);
    expect(docs({ method: "POST", headers: { accept: "application/json", "x-sveltekit-action": "true" } })).toBe(true);
    expect(docs({ headers: { accept: IMAGE } })).toBe(false);
    expect(docs({ headers: { accept: "*/*" } })).toBe(false);
    expect(docs({ method: "PUT", headers: { accept: NAVIGATION } })).toBe(false);
    // Without route information the same negotiation applies.
    expect(needsRuntimeContext(request("/docs/intro", { headers: { accept: IMAGE } }))).toBe(false);
    expect(needsRuntimeContext(request("/docs/intro", { headers: { accept: NAVIGATION } }))).toBe(true);
  });
});

describe("prefersHtml", () => {
  it("follows SvelteKit's page and endpoint negotiation", () => {
    expect(prefersHtml(NAVIGATION)).toBe(true);
    expect(prefersHtml("text/*")).toBe(true);
    expect(prefersHtml("*/*")).toBe(false);
    expect(prefersHtml(null)).toBe(false);
    expect(prefersHtml(IMAGE)).toBe(false);
    expect(prefersHtml("application/json, text/html;q=0.5")).toBe(true);
    expect(prefersHtml("application/json, */*;q=0.9, text/html;q=0.5")).toBe(false);
    expect(prefersHtml("*/*;q=0.9, text/html")).toBe(true);
    expect(prefersHtml("text/html;q=0, */*")).toBe(false);
  });
});
