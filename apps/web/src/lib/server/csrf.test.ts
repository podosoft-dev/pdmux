import type { RequestEvent } from "@sveltejs/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isCrossSiteFormSubmission, refuseCrossSiteForm } from "./csrf";

const runtime = vi.hoisted(() => ({ dev: false }));
vi.mock("$app/env", () => ({
  get dev(): boolean {
    return runtime.dev;
  },
}));

const SITE = "https://app.example.com";
const FOREIGN = "https://cross-site.example";

function request(path: string, init: RequestInit & { origin?: string } = {}): [Request, URL] {
  const { origin, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (origin !== undefined) headers.set("origin", origin);
  const url = new URL(path, SITE);
  return [new Request(url, { method: "POST", ...rest, headers }), url];
}

function crossSite(path: string, init: RequestInit & { origin?: string } = {}, trusted: string[] = []): boolean {
  const [req, url] = request(path, init);
  return isCrossSiteFormSubmission(req, url, trusted);
}

describe("cross-site form check", () => {
  afterEach(() => {
    runtime.dev = false;
  });

  it("passes /api requests without an Origin header, as API clients send them", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(crossSite("/api/items/1", { method }), method).toBe(false);
    }
    expect(crossSite("/api", {})).toBe(false);
    expect(crossSite("/api/files", { body: new FormData() })).toBe(false);
    expect(crossSite("/api/notes", { headers: { "content-type": "text/plain" }, body: "note" })).toBe(false);
    expect(
      crossSite("/api/login", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "a=1",
      }),
    ).toBe(false);
  });

  it("refuses form submissions from another origin on /api and pages", () => {
    for (const path of ["/api/items", "/api", "/login", "/"]) {
      expect(crossSite(path, { origin: FOREIGN }), path).toBe(true);
      expect(crossSite(path, { origin: FOREIGN, body: new FormData() }), path).toBe(true);
      expect(crossSite(path, { origin: "null", headers: { "content-type": "text/plain; charset=UTF-8" } }), path).toBe(true);
    }
    expect(crossSite("/api/items", { method: "DELETE", origin: FOREIGN })).toBe(true);
    expect(crossSite("/api/items", { origin: FOREIGN, headers: { "content-type": "Multipart/Form-Data; boundary=x" } })).toBe(true);
    expect(crossSite("/report", { origin: FOREIGN, headers: { "content-type": "application/x-sveltekit-formdata" } })).toBe(true);
  });

  it("refuses page form submissions without an Origin header, as SvelteKit does", () => {
    expect(crossSite("/login", {})).toBe(true);
    expect(crossSite("/login", { body: new FormData() })).toBe(true);
    // A path that only starts with "api" is a page.
    expect(crossSite("/apis", {})).toBe(true);
  });

  it("passes same-origin submissions, other content types, and safe methods", () => {
    expect(crossSite("/login", { origin: SITE, body: new FormData() })).toBe(false);
    expect(crossSite("/api/items", { origin: SITE })).toBe(false);
    expect(crossSite("/api/items", { origin: FOREIGN, headers: { "content-type": "application/json" }, body: "{}" })).toBe(false);
    expect(crossSite("/login", { headers: { "content-type": "application/octet-stream" }, body: "x" })).toBe(false);
    expect(crossSite("/login", { method: "GET", origin: FOREIGN })).toBe(false);
    expect(crossSite("/login", { method: "OPTIONS", origin: FOREIGN })).toBe(false);
  });

  it("passes trusted origins, or every origin with *", () => {
    expect(crossSite("/login", { origin: FOREIGN }, [FOREIGN])).toBe(false);
    expect(crossSite("/login", { origin: "https://other.example" }, [FOREIGN])).toBe(true);
    // A trusted origin does not stand in for a missing Origin header.
    expect(crossSite("/login", {}, [FOREIGN])).toBe(true);
    expect(crossSite("/login", { origin: FOREIGN }, ["*"])).toBe(false);
    expect(crossSite("/login", {}, ["*"])).toBe(false);
  });

  it("answers with SvelteKit's 403, as JSON when the client asks for it", async () => {
    const [plain, url] = request("/login", { origin: FOREIGN, body: new FormData() });
    const refused = refuseCrossSiteForm({ request: plain, url } as RequestEvent);
    expect(refused?.status).toBe(403);
    expect(await refused?.text()).toBe("Cross-site POST form submissions are forbidden");

    const [asJson] = request("/api/items", { method: "DELETE", origin: FOREIGN, headers: { accept: "application/json" } });
    const refusedJson = refuseCrossSiteForm({ request: asJson, url: new URL("/api/items", SITE) } as RequestEvent);
    expect(refusedJson?.status).toBe(403);
    expect(await refusedJson?.json()).toEqual({ message: "Cross-site DELETE form submissions are forbidden" });

    const [allowed, apiUrl] = request("/api/items");
    expect(refuseCrossSiteForm({ request: allowed, url: apiUrl } as RequestEvent)).toBeNull();
  });

  it("does not check requests on the Vite dev server, like SvelteKit", () => {
    runtime.dev = true;
    const [req, url] = request("/login", { origin: FOREIGN, body: new FormData() });
    expect(refuseCrossSiteForm({ request: req, url } as RequestEvent)).toBeNull();
  });
});
