import { afterEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppException } from "@podosoft/podokit-contracts";
import { IN_MEMORY_READ_BYTES, LocalObjectStore } from "@podosoft/podokit-runtime";
import { Elysia } from "elysia";
import type { RequestIdentity } from "../core/services";
import { DownloadUrlSigner, SignedDownloadStore } from "./download-url";
import {
  DOWNLOAD_BASE_URL,
  downloadSafetyHeaders,
  localStorageRoutes,
  multipartMaxAgeMs,
} from "./storage-local.module";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

interface Fixture {
  directory: string;
  storage: SignedDownloadStore;
  signer: DownloadUrlSigner;
}

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "podokit-storage-"));
  root = directory;
  const signer = new DownloadUrlSigner(join(directory, ".podokit", "download-url.key"));
  const storage = new SignedDownloadStore(
    new LocalObjectStore({ rootDirectory: directory, publicBaseUrl: DOWNLOAD_BASE_URL }),
    signer,
    DOWNLOAD_BASE_URL,
  );
  return { directory, storage, signer };
}

function caller(userId: string | undefined, admin = false): RequestIdentity {
  return {
    userId: async () => userId,
    isAdmin: async () => admin,
    roles: async () => (admin ? ["admin"] : []),
    activeOrganizationId: async () => undefined,
  };
}

interface Reply {
  status: number;
  text: string;
  contentType: string | null;
  headers: Headers;
}

interface Handler {
  handle(request: Request): Promise<Response>;
}

function routes({ storage, signer }: Fixture, identity: RequestIdentity): Handler {
  return new Elysia()
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
    .use(localStorageRoutes(storage, signer, identity));
}

async function call(
  local: Fixture,
  identity: RequestIdentity,
  method: "GET" | "PUT",
  path: string,
  content?: string,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const response = await routes(local, identity).handle(new Request(`http://localhost${path}`, {
    method,
    headers: { ...(content === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(content === undefined ? {} : { body: JSON.stringify({ content }) }),
  }));
  return {
    status: response.status,
    text: await response.text(),
    contentType: response.headers.get("content-type"),
    headers: response.headers,
  };
}

function code(reply: Reply): unknown {
  return (JSON.parse(reply.text) as { code?: unknown }).code;
}

describe("local object storage provider", () => {
  it("stores and reads an object without allowing traversal", async () => {
    const { storage } = await fixture();
    await storage.put("uploads/hello.txt", "hello", { contentType: "text/plain" });
    expect(await storage.exists("uploads/hello.txt")).toBe(true);
    expect(await storage.getDownloadUrl("uploads/hello.txt")).toStartWith(
      "/files/content/uploads/hello.txt?expires=",
    );
    await expect(storage.put("../outside.txt", "no")).rejects.toThrow("safe relative path");
  });

  it("serves an object only through an unaltered signed URL", async () => {
    const local = await fixture();
    const anonymous = caller(undefined);
    await local.storage.put("uploads/a/one.txt", "one", { contentType: "text/plain" });
    await local.storage.put("uploads/b/two.txt", "two", { contentType: "text/plain" });
    const signed = await local.storage.getDownloadUrl("uploads/a/one.txt");

    const download = await call(local, anonymous, "GET", signed);
    expect(download).toMatchObject({ status: 200, text: "one", contentType: "text/plain" });
    expect(download.headers.get("content-length")).toBe("3");
    expect(download.headers.get("last-modified")).toBeTruthy();
    const etag = download.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"[^"]+"$/);
    const revalidated = await call(local, anonymous, "GET", signed, undefined, { "if-none-match": etag });
    expect(revalidated).toMatchObject({ status: 304, text: "" });

    const unsigned = await call(local, anonymous, "GET", "/files/content/uploads/a/one.txt");
    expect(unsigned.status).toBe(403);
    expect(code(unsigned)).toBe("DOWNLOAD_URL_INVALID");

    const swapped = await call(local, anonymous, "GET", signed.replace("a/one.txt", "b/two.txt"));
    expect(swapped.status).toBe(403);

    await local.storage.delete("uploads/a/one.txt");
    const missing = await call(local, anonymous, "GET", signed);
    expect(missing.status).toBe(404);
    expect(code(missing)).toBe("STORAGE_OBJECT_NOT_FOUND");
  });

  it("serves objects through Bun with the Content-Length of those read into memory", async () => {
    const local = await fixture();
    const app = routes(local, caller(undefined));
    const server = Bun.serve({ port: 0, fetch: (request) => app.handle(request) });
    try {
      for (const size of [68, 100 * 1024, IN_MEMORY_READ_BYTES, IN_MEMORY_READ_BYTES + 1]) {
        const content = randomBytes(size);
        const key = `uploads/served-${size}.bin`;
        await local.storage.put(key, content, { contentType: "image/png" });
        const response = await fetch(new URL(await local.storage.getDownloadUrl(key), server.url));
        expect(response.status).toBe(200);
        if (size <= IN_MEMORY_READ_BYTES) {
          expect(response.headers.get("content-length")).toBe(String(size));
          expect(response.headers.get("transfer-encoding")).toBeNull();
        } else {
          // Streamed from the file, which Bun may send chunked; a length must still be right.
          expect(response.headers.get("content-length") ?? String(size)).toBe(String(size));
        }
        expect(Buffer.from(await response.arrayBuffer()).equals(content)).toBe(true);
      }
    } finally {
      server.stop(true);
    }
  });

  it("limits the demo routes to administrators", async () => {
    const local = await fixture();

    const anonymous = await call(local, caller(undefined), "PUT", "/storage/hello", "x");
    expect(anonymous.status).toBe(401);
    expect(code(anonymous)).toBe("AUTH_REQUIRED");
    for (const [method, path] of [
      ["PUT", "/storage/hello"],
      ["GET", "/storage/hello"],
      ["GET", "/storage/hello/presigned"],
    ] as const) {
      const reply = await call(local, caller("user-1"), method, path, method === "PUT" ? "x" : undefined);
      expect(reply.status).toBe(403);
      expect(code(reply)).toBe("ADMIN_REQUIRED");
    }
    expect(existsSync(join(local.directory, "demo"))).toBe(false);
  });

  it("keeps administrator demo objects under the demo prefix", async () => {
    const local = await fixture();
    const admin = caller("admin-1", true);

    expect((await call(local, admin, "PUT", "/storage/hello", "hi")).status).toBe(200);
    expect(existsSync(join(local.directory, "demo", "hello"))).toBe(true);
    const read = await call(local, admin, "GET", "/storage/hello");
    expect(read).toMatchObject({ status: 200, text: "hi", contentType: "text/plain" });
    expect(read.headers.get("content-length")).toBe("2");
    expect(read.headers.get("x-content-type-options")).toBe("nosniff");
    const presigned = JSON.parse((await call(local, admin, "GET", "/storage/hello/presigned")).text) as {
      url: string;
    };
    expect(presigned.url).toStartWith("/files/content/demo/hello?");
    expect((await call(local, caller(undefined), "GET", presigned.url)).text).toBe("hi");

    for (const key of ["site%2Ffavicon", "..%2Fsite%2Ffavicon", ".podokit", "%2E%2E"]) {
      const reply = await call(local, admin, "PUT", `/storage/${key}`, "x");
      expect([400, 404]).toContain(reply.status);
    }
    expect(existsSync(join(local.directory, "site"))).toBe(false);
    expect((await call(local, admin, "GET", "/storage/missing")).status).toBe(404);
  });
});

describe("local multipart uploads", () => {
  it("assembles an object from parts through the signed store", async () => {
    const local = await fixture();
    const { uploadId } = await local.storage.createMultipartUpload("uploads/big.txt", { contentType: "text/plain" });
    const second = await local.storage.uploadPart("uploads/big.txt", uploadId, 2, "world");
    const first = await local.storage.uploadPart("uploads/big.txt", uploadId, 1, new Blob(["x".repeat(5 * 1024 * 1024)]));
    const info = await local.storage.completeMultipartUpload("uploads/big.txt", uploadId, [
      { partNumber: 1, etag: first.etag },
      { partNumber: 2, etag: second.etag },
    ]);
    expect(info).toMatchObject({ size: 5 * 1024 * 1024 + 5, contentType: "text/plain" });
    const object = await local.storage.get("uploads/big.txt");
    expect((await new Response(object?.body).text()).endsWith("xworld")).toBe(true);

    const aborted = await local.storage.createMultipartUpload("uploads/aborted.txt");
    await local.storage.abortMultipartUpload("uploads/aborted.txt", aborted.uploadId);
    expect(existsSync(join(local.directory, ".podokit", "multipart", aborted.uploadId))).toBe(false);
  });

  it("reads the idle multipart lifetime in seconds", () => {
    expect(multipartMaxAgeMs(undefined)).toBe(24 * 60 * 60 * 1000);
    expect(multipartMaxAgeMs("")).toBe(24 * 60 * 60 * 1000);
    expect(multipartMaxAgeMs("3600")).toBe(3_600_000);
    for (const value of ["0", "-1", "1.5", "a day"]) {
      expect(() => multipartMaxAgeMs(value)).toThrow("LOCAL_STORAGE_MULTIPART_MAX_AGE");
    }
  });
});

describe("local download safety headers", () => {
  it("renders only script-free types inline", () => {
    expect(downloadSafetyHeaders("image/png")["content-disposition"]).toBe("inline");
    expect(downloadSafetyHeaders("text/plain; charset=utf-8")["content-disposition"]).toBe("inline");
    for (const type of ["text/html", "image/svg+xml", "application/xml", "application/javascript", undefined]) {
      expect(downloadSafetyHeaders(type)["content-disposition"]).toBe("attachment");
    }
  });

  it("always forbids sniffing and script execution", () => {
    const headers = downloadSafetyHeaders("image/png");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
  });
});
