import { describe, expect, it } from "bun:test";
import { generateAuthOpenApiDocument, isAuthOpenApiApi } from "./auth.openapi";

describe("Better Auth OpenAPI integration", () => {
  it("accepts the generated OpenAPI API without weakening the auth type", async () => {
    const api: unknown = {
      generateOpenAPISchema: () => ({ openapi: "3.1.0", paths: {} }),
    };

    expect(isAuthOpenApiApi(api)).toBe(true);
    expect(await generateAuthOpenApiDocument(api)).toEqual({ openapi: "3.1.0", paths: {} });
  });

  it("rejects missing and malformed OpenAPI integrations", async () => {
    expect(isAuthOpenApiApi({})).toBe(false);
    expect(generateAuthOpenApiDocument({ generateOpenAPISchema: () => null })).rejects.toThrow(
      "invalid OpenAPI document",
    );
  });
});
