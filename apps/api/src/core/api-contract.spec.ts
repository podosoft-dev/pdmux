import { describe, expect, it } from "bun:test";
import {
  assertApiContract,
  assertConsistentRouteParameters,
  documentedApiRoutes,
  expectedApiRoutes,
  missingApiRoutes,
} from "./api-contract";

describe("API contract inventory", () => {
  it("covers the core, Todo, module, and Better Auth routes", () => {
    const expected = expectedApiRoutes("todo", ["auth", "redis", "file-upload"]);

    expect(expected).toContain("GET /health/ready");
    expect(expected).toContain("PATCH /todos/{id}");
    expect(expected).toContain("POST /api/auth/sign-in/email");
    expect(expected).toContain("PUT /cache/{key}");
    expect(expected).toContain("POST /files");
  });

  it("uses one structural parameter name for every public blog post route", () => {
    const expected = expectedApiRoutes("fullstack", ["blog"]);

    expect(expected).toContain("GET /blog/{postRef}");
    expect(expected).toContain("PATCH /blog/{postRef}");
    expect(expected).toContain("POST /blog/{postRef}/comments");
    expect(expected).not.toContain("GET /blog/{slug}");
    expect(expected).not.toContain("PATCH /blog/{id}");
  });

  it("normalizes OpenAPI operations and reports an exact missing route", () => {
    const document = { paths: { "/health": { get: {} }, "/health/ready": { get: {} } } };

    expect(documentedApiRoutes(document)).toEqual(new Set(["GET /health", "GET /health/ready"]));
    expect(missingApiRoutes(document, "fullstack", ["redis"])).toEqual([
      "GET /cache/{key}",
      "PUT /cache/{key}",
    ]);
    expect(() => assertApiContract(document, "fullstack", ["redis"])).toThrow(
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
});
