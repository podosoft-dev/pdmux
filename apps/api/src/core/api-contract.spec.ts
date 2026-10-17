import { describe, expect, it } from "bun:test";
import { LOCAL_PROVIDER_SELECTIONS, SERVER_PROVIDER_SELECTIONS } from "@podosoft/podokit-runtime";
import {
  assertApiContract,
  assertApplicationRoutes,
  assertConsistentRouteParameters,
  documentedApiRoutes,
  expectedApiRoutes,
  missingApiRoutes,
  normalizeApiRoute,
  registeredApiRoutes,
} from "./api-contract";

describe("API contract inventory", () => {
  it("covers the core, Todo, module, and Better Auth routes", () => {
    const expected = expectedApiRoutes("todo", ["auth", "redis", "file-upload"], SERVER_PROVIDER_SELECTIONS);

    expect(expected).toContain("GET /health/ready");
    expect(expected).toContain("PATCH /todos/{id}");
    expect(expected).toContain("POST /api/auth/sign-in/email");
    expect(expected).toContain("PUT /cache/{key}");
    expect(expected).toContain("POST /files");
    expect(expected).toContain("PUT /files/uploads/{id}/parts/{partNumber}");
  });

  it("uses one structural parameter name for every public blog post route", () => {
    const expected = expectedApiRoutes("fullstack", ["blog"], SERVER_PROVIDER_SELECTIONS);

    expect(expected).toContain("GET /blog/{postRef}");
    expect(expected).toContain("PATCH /blog/{postRef}");
    expect(expected).toContain("POST /blog/{postRef}/comments");
    expect(expected).not.toContain("GET /blog/{slug}");
    expect(expected).not.toContain("PATCH /blog/{id}");
  });

  it("expects a provider module's routes only while its provider is selected", () => {
    const modules = [
      "object-storage-s3",
      "object-storage-local",
      "redis",
      "cache-memory",
      "bullmq",
      "jobs-local",
    ];
    const server = expectedApiRoutes("fullstack", modules, SERVER_PROVIDER_SELECTIONS);
    const local = expectedApiRoutes("fullstack", modules, LOCAL_PROVIDER_SELECTIONS);

    expect(server).toContain("PUT /storage/{key}");
    expect(server).not.toContain("GET /files/content/*");
    expect(server).toContain("PUT /cache/{key}");
    expect(server).toContain("POST /jobs");
    expect(local).toContain("PUT /storage/{key}");
    expect(local).toContain("GET /files/content/*");
    expect(local).not.toContain("PUT /cache/{key}");
    expect(local).not.toContain("GET /cache/{key}");
    expect(local).toContain("GET /jobs/{id}");

    const s3Document = {
      paths: {
        "/health": { get: {} },
        "/health/ready": { get: {} },
        "/storage/{key}": { get: {}, put: {} },
        "/storage/{key}/presigned": { get: {} },
      },
    };
    const storage = ["object-storage-s3", "object-storage-local"];
    expect(() => assertApiContract(s3Document, "fullstack", storage, SERVER_PROVIDER_SELECTIONS)).not.toThrow();
    expect(() => assertApiContract(s3Document, "fullstack", storage, {
      ...SERVER_PROVIDER_SELECTIONS,
      "object-storage": "local",
    })).toThrow("GET /files/content/*");
  });

  it("normalizes OpenAPI operations and reports an exact missing route", () => {
    const document = { paths: { "/health": { get: {} }, "/health/ready": { get: {} } } };

    expect(documentedApiRoutes(document)).toEqual(new Set(["GET /health", "GET /health/ready"]));
    expect(missingApiRoutes(document, "fullstack", ["redis"], SERVER_PROVIDER_SELECTIONS)).toEqual([
      "GET /cache/{key}",
      "PUT /cache/{key}",
    ]);
    expect(() => assertApiContract(document, "fullstack", ["redis"], SERVER_PROVIDER_SELECTIONS)).toThrow(
      "OpenAPI contract is missing routes",
    );
  });

  it("rejects different parameter names at one router position", () => {
    expect(() => assertConsistentRouteParameters([
      { method: "GET", path: "/hosts/:hostId" },
      { method: "GET", path: "/hosts/:hostId/files/:path" },
      { method: "DELETE", path: "/hosts/:id/services/:serviceId" },
    ])).toThrow(
      "API routes at the same structural position must use one parameter name",
    );

    expect(() => assertConsistentRouteParameters([
      { method: "GET", path: "/hosts/:hostId" },
      { method: "GET", path: "/hosts/:hostId/files/:path" },
      { method: "DELETE", path: "/hosts/:hostId/services/:serviceId" },
    ])).not.toThrow();
  });

  it("normalizes runtime and OpenAPI parameter syntax", () => {
    expect(normalizeApiRoute("get /reports/:id/rows/:rowId")).toBe("GET /reports/{id}/rows/{rowId}");
    expect(normalizeApiRoute("GET /reports/{id}")).toBe("GET /reports/{id}");
    expect(registeredApiRoutes([
      { method: "GET", path: "/reports/:id" },
      { method: "POST", path: "/reports" },
      { path: "/no-method" },
    ])).toEqual(new Set(["GET /reports/{id}", "POST /reports"]));
  });

  it("requires every application route to be registered and documented", () => {
    const document = { paths: { "/reports/{id}": { get: {} }, "/hidden": {} } };
    const routes = [{ method: "GET", path: "/reports/:id" }, { method: "DELETE", path: "/hidden" }];

    expect(() => assertApplicationRoutes(document, routes, ["GET /reports/:id", "GET /reports/{id}"])).not.toThrow();
    expect(() => assertApplicationRoutes(document, routes, [])).not.toThrow();
    expect(() => assertApplicationRoutes(document, routes, ["DELETE /hidden", "POST /reports"])).toThrow(
      [
        "Application API contract failed:",
        "DELETE /hidden is missing from the OpenAPI document",
        "POST /reports is not registered",
        "POST /reports is missing from the OpenAPI document",
      ].join("\n"),
    );
  });
});
