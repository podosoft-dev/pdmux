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

export interface AuthWithApi {
  api: unknown;
}

export type AuthOpenApiDocuments = (auth: AuthWithApi) => Promise<Record<string, unknown>>;

/** Generating the schema rebuilds every plugin's endpoints, so reuse it until the
 *  auth instance is rebuilt. A rejected generation is dropped so the next call retries. */
export function cachedAuthOpenApiDocuments(): AuthOpenApiDocuments {
  const documents = new WeakMap<AuthWithApi, Promise<Record<string, unknown>>>();
  return (auth) => {
    const cached = documents.get(auth);
    if (cached) return cached;
    const document = generateAuthOpenApiDocument(auth.api);
    documents.set(auth, document);
    document.catch(() => {
      if (documents.get(auth) === document) documents.delete(auth);
    });
    return document;
  };
}
