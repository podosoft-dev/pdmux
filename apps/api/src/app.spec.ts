import { describe, expect, it, mock, type Mock } from "bun:test";
import {
  cachedOpenApiDocument,
  setRetryAfter,
  UNAVAILABLE_RETRY_AFTER_SECONDS,
  type OpenApiDocumentLoader,
} from "./app";
import type { OpenApiContribution } from "./core/services";

function baseSpec(): Response {
  return Response.json({ openapi: "3.1.0", paths: { "/health": { get: {} } } });
}

function source(options: {
  contributions: () => OpenApiContribution[];
  routeCount?: () => number;
  base?: () => Response;
}): { base: Mock<() => Promise<Response>>; load: OpenApiDocumentLoader } {
  const base = mock(async () => (options.base ?? baseSpec)());
  const load = cachedOpenApiDocument({
    routeCount: options.routeCount ?? (() => 1),
    base,
    contributions: async () => options.contributions(),
  });
  return { base, load };
}

describe("cachedOpenApiDocument", () => {
  it("reuses the merged document while the inputs are unchanged", async () => {
    const auth = { document: { paths: { "/sign-in": { post: {} } } }, pathPrefix: "/api/auth" };
    const { base, load } = source({ contributions: () => [{ ...auth }] });

    const first = await load();
    const second = await load();

    expect(second).toBe(first);
    expect(first).toMatchObject({
      paths: { "/health": { get: {} }, "/api/auth/sign-in": { post: {} } },
    });
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("rebuilds when a contributor returns a new document", async () => {
    let auth: OpenApiContribution = {
      document: { paths: { "/sign-in": { post: {} } } },
      pathPrefix: "/api/auth",
    };
    const { base, load } = source({ contributions: () => [auth] });

    await load();
    auth = { document: { paths: { "/passkey": { post: {} } } }, pathPrefix: "/api/auth" };
    const rebuilt = await load();

    expect(rebuilt).toMatchObject({ paths: { "/api/auth/passkey": { post: {} } } });
    expect(rebuilt).not.toHaveProperty(["paths", "/api/auth/sign-in"]);
    expect(base).toHaveBeenCalledTimes(2);
  });

  it("rebuilds when routes are added", async () => {
    let routes = 1;
    const { base, load } = source({ contributions: () => [], routeCount: () => routes });

    await load();
    routes = 2;
    await load();

    expect(base).toHaveBeenCalledTimes(2);
  });

  it("returns a failed base response without caching it", async () => {
    let fail = true;
    const { base, load } = source({
      contributions: () => [],
      base: () => fail ? Response.json({ success: false }, { status: 503 }) : baseSpec(),
    });

    const failed = await load();
    fail = false;
    const recovered = await load();

    if (!(failed instanceof Response)) throw new Error("Expected the failed base response");
    expect(failed.status).toBe(503);
    expect(recovered).toMatchObject({ openapi: "3.1.0" });
    expect(base).toHaveBeenCalledTimes(2);
  });
});

describe("setRetryAfter", () => {
  it("tells clients when to retry", () => {
    const headers: Record<string, string | number> = {};
    setRetryAfter(headers);
    expect(headers).toEqual({ "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS) });
  });

  it("keeps a value the failing code already set, in any letter case", () => {
    const headers: Record<string, string | number> = { "Retry-After": "7" };
    setRetryAfter(headers);
    expect(headers).toEqual({ "Retry-After": "7" });
  });
});
