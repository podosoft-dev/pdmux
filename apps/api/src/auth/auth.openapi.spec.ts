import { describe, expect, it, mock, type Mock } from "bun:test";
import {
  cachedAuthOpenApiDocuments,
  generateAuthOpenApiDocument,
  isAuthOpenApiApi,
} from "./auth.openapi";

type GenerateSchema = () => Promise<Record<string, unknown>>;

function authInstance(version: string): { api: { generateOpenAPISchema: Mock<GenerateSchema> } } {
  return {
    api: {
      generateOpenAPISchema: mock<GenerateSchema>(async () => ({
        openapi: "3.1.0",
        info: { version },
        paths: {},
      })),
    },
  };
}

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

  it("reuses the generated document for the same auth instance", async () => {
    const documents = cachedAuthOpenApiDocuments();
    const auth = authInstance("1");

    const first = await documents(auth);
    const second = await documents(auth);

    expect(second).toBe(first);
    expect(auth.api.generateOpenAPISchema).toHaveBeenCalledTimes(1);
  });

  it("generates a fresh document after the auth instance is rebuilt", async () => {
    const documents = cachedAuthOpenApiDocuments();
    const original = authInstance("1");
    const rebuilt = authInstance("2");

    const before = await documents(original);
    const after = await documents(rebuilt);

    expect(after).not.toBe(before);
    expect(after).toMatchObject({ info: { version: "2" } });
    expect(rebuilt.api.generateOpenAPISchema).toHaveBeenCalledTimes(1);
  });

  it("retries after a rejected generation instead of caching the failure", async () => {
    const documents = cachedAuthOpenApiDocuments();
    const auth = authInstance("1");
    auth.api.generateOpenAPISchema.mockImplementationOnce(async () => {
      throw new Error("plugin endpoints unavailable");
    });

    await expect(documents(auth)).rejects.toThrow("plugin endpoints unavailable");
    await expect(documents(auth)).resolves.toMatchObject({ openapi: "3.1.0" });
    expect(auth.api.generateOpenAPISchema).toHaveBeenCalledTimes(2);
  });
});
