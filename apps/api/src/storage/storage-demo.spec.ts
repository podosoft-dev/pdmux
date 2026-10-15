import { describe, expect, it } from "bun:test";
import { AppException } from "@podosoft/podokit-contracts";
import { Elysia } from "elysia";
import type { RequestIdentity } from "../core/services";
import { storageDemoRoutes, type DemoStorage } from "./storage.module";

interface MemoryStorage extends DemoStorage {
  objects: Map<string, string>;
  presigned: string[];
}

function memoryStorage(): MemoryStorage {
  const objects = new Map<string, string>();
  const presigned: string[] = [];
  return {
    objects,
    presigned,
    put: async (key, body) => {
      if (typeof body === "string") objects.set(key, body);
      else if (body instanceof Blob) objects.set(key, await body.text());
      else objects.set(key, Buffer.from(body).toString("utf8"));
    },
    open: async (key) => {
      const content = objects.get(key);
      if (content === undefined) return null;
      const bytes = Buffer.from(content);
      return {
        key,
        size: bytes.byteLength,
        contentType: "text/plain",
        etag: `"${bytes.toString("hex")}"`,
        lastModified: new Date("2026-01-02T03:04:05Z"),
        body: new Blob([bytes]).stream(),
      };
    },
    presignedGetUrl: async (key) => {
      presigned.push(key);
      return `https://storage.example.com/${key}?signature=test`;
    },
  };
}

function caller(userId: string | undefined, admin = false): RequestIdentity {
  return {
    userId: async () => userId,
    isAdmin: async () => admin,
    roles: async () => (admin ? ["admin"] : []),
    activeOrganizationId: async () => undefined,
  };
}

async function call(
  storage: DemoStorage,
  identity: RequestIdentity,
  method: "GET" | "PUT",
  path: string,
  options: { content?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const app = new Elysia()
    .onError(({ code, error, set }) => {
      if (error instanceof AppException) {
        set.status = error.statusCode;
        return { code: error.code };
      }
      if (code === "VALIDATION") {
        set.status = 400;
        return { code: "VALIDATION_ERROR" };
      }
      if (code === "NOT_FOUND") {
        set.status = 404;
        return { code: "NOT_FOUND" };
      }
      return undefined;
    })
    .use(storageDemoRoutes(storage, identity));
  return app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(options.content === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    ...(options.content === undefined ? {} : { body: JSON.stringify({ content: options.content }) }),
  }));
}

async function reply(response: Promise<Response>): Promise<{ status: number; body: unknown }> {
  const resolved = await response;
  return { status: resolved.status, body: await resolved.json() };
}

describe("object storage demo routes", () => {
  it("require a signed-in administrator", async () => {
    const storage = memoryStorage();

    expect(await reply(call(storage, caller(undefined), "PUT", "/storage/hello", { content: "x" }))).toEqual({
      status: 401,
      body: { code: "AUTH_REQUIRED" },
    });
    for (const [method, path] of [
      ["PUT", "/storage/hello"],
      ["GET", "/storage/hello"],
      ["GET", "/storage/hello/presigned"],
    ] as const) {
      const response = call(storage, caller("user-1"), method, path, method === "PUT" ? { content: "x" } : {});
      expect(await reply(response)).toEqual({ status: 403, body: { code: "ADMIN_REQUIRED" } });
    }
    expect(storage.objects.size).toBe(0);
    expect(storage.presigned).toEqual([]);
  });

  it("stores, streams, and presigns objects under the demo prefix for administrators", async () => {
    const storage = memoryStorage();
    const admin = caller("admin-1", true);

    expect(await reply(call(storage, admin, "PUT", "/storage/hello", { content: "hi" }))).toEqual({
      status: 200,
      body: { key: "hello" },
    });
    expect([...storage.objects.keys()]).toEqual(["demo/hello"]);

    const read = await call(storage, admin, "GET", "/storage/hello");
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("text/plain");
    expect(read.headers.get("content-length")).toBe("2");
    expect(read.headers.get("x-content-type-options")).toBe("nosniff");
    const etag = read.headers.get("etag");
    expect(etag).toBe("\"6869\"");
    expect(await read.text()).toBe("hi");

    const revalidated = await call(storage, admin, "GET", "/storage/hello", {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");

    const presigned = await call(storage, admin, "GET", "/storage/hello/presigned");
    expect(presigned.status).toBe(200);
    expect(storage.presigned).toEqual(["demo/hello"]);
  });

  it("reports a missing demo object as not found", async () => {
    const response = call(memoryStorage(), caller("admin-1", true), "GET", "/storage/missing");
    expect(await reply(response)).toEqual({ status: 404, body: { code: "STORAGE_OBJECT_NOT_FOUND" } });
  });

  it("rejects keys that would leave the demo prefix", async () => {
    const storage = memoryStorage();
    const admin = caller("admin-1", true);

    for (const key of ["site%2Ffavicon", "profile-images%2Fa.png", "..%2Fsite%2Ffavicon", ".podokit", "%2E%2E"]) {
      const response = await call(storage, admin, "PUT", `/storage/${key}`, { content: "x" });
      expect([400, 404]).toContain(response.status);
    }
    expect(storage.objects.size).toBe(0);
  });
});
