interface AuthOpenApiApi {
  generateOpenAPISchema: () => unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAuthOpenApiApi(value: unknown): value is AuthOpenApiApi {
  return isRecord(value) && typeof value.generateOpenAPISchema === "function";
}

export async function generateAuthOpenApiDocument(api: unknown): Promise<Record<string, unknown>> {
  if (!isAuthOpenApiApi(api)) {
    throw new Error("Better Auth OpenAPI plugin is unavailable");
  }
  const document: unknown = await api.generateOpenAPISchema();
  if (!isRecord(document)) {
    throw new Error("Better Auth returned an invalid OpenAPI document");
  }
  return document;
}
