import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppException } from "@podosoft/podokit-contracts";
import { LocalObjectStore, type ObjectData } from "@podosoft/podokit-runtime";
import { Elysia } from "elysia";
import type { Logger } from "pino";
import { ProfileImageService } from "../profile-image/profile-image.service";
import type { SiteFavicon } from "../site-settings/site-settings.service";
import { faviconCacheControl, IMMUTABLE_CACHE_CONTROL, siteAssetRoutes } from "./site-assets.routes";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADAQMAAACDJEzCAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURWYzmf///129H+IAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gcVCSUTzXBDTwAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNy0yMVQwOTozNzoxOSswMDowMOuehLIAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDctMjFUMDk6Mzc6MTkrMDA6MDCawzwOAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA3LTIxVDA5OjM3OjE5KzAwOjAwzdYd0QAAAAtJREFUCNdjYAABAAAGAAFm9MlsAAAAAElFTkSuQmCC",
  "base64",
);

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function localStore(): Promise<LocalObjectStore> {
  const directory = await mkdtemp(join(tmpdir(), "podokit-site-assets-"));
  directories.push(directory);
  return new LocalObjectStore({ rootDirectory: directory });
}

interface TrackedObject {
  object: ObjectData;
  read: () => boolean;
}

function trackedObject(content: string): TrackedObject {
  let read = false;
  const bytes = Buffer.from(content);
  return {
    object: {
      key: "site/favicon",
      size: bytes.byteLength,
      contentType: "application/octet-stream",
      etag: "\"favicon-1\"",
      lastModified: new Date("2026-01-02T03:04:05Z"),
      body: new ReadableStream<Uint8Array>({
        pull(controller): void {
          read = true;
          controller.enqueue(bytes);
          controller.close();
        },
      }, { highWaterMark: 0 }),
    },
    read: () => read,
  };
}

type Get = (path: string, headers?: Record<string, string>) => Promise<Response>;

function app(
  favicon: () => SiteFavicon | null,
  profileImages: Pick<ProfileImageService, "get">,
): Get {
  const target = new Elysia()
    .onError(({ error, set }) => {
      if (!(error instanceof AppException)) return undefined;
      set.status = error.statusCode;
      return { code: error.code };
    })
    .use(siteAssetRoutes({ getFavicon: async () => favicon() }, profileImages));
  return async (path, headers = {}) => target.handle(new Request(`http://localhost${path}`, { headers }));
}

const noProfileImages: Pick<ProfileImageService, "get"> = {
  get: () => Promise.reject(new Error("unused")),
};

describe("GET /site/favicon", () => {
  test("streams the favicon with the validated type and its validators", async () => {
    const icon = trackedObject("<svg/>");
    const get = app(() => ({ object: icon.object, contentType: "image/svg+xml", version: "1700" }), noProfileImages);
    const response = await get("/site/favicon");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-length")).toBe("6");
    expect(response.headers.get("etag")).toBe("\"favicon-1\"");
    expect(response.headers.get("last-modified")).toBe("Fri, 02 Jan 2026 03:04:05 GMT");
    expect(await response.text()).toBe("<svg/>");
  });

  test("answers a current copy with 304 without reading storage", async () => {
    const icon = trackedObject("<svg/>");
    const get = app(() => ({ object: icon.object, contentType: "image/svg+xml", version: "1700" }), noProfileImages);
    const response = await get("/site/favicon", { "if-none-match": "\"favicon-1\"" });

    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(icon.read()).toBe(false);
  });

  test("caches the current version for good and revalidates any other URL", async () => {
    const get = (path: string, headers: Record<string, string> = {}): Promise<Response> => {
      const icon = trackedObject("<svg/>");
      return app(() => ({ object: icon.object, contentType: "image/svg+xml", version: "1700" }), noProfileImages)(
        path,
        headers,
      );
    };

    const current = await get("/site/favicon?v=1700");
    expect(current.status).toBe(200);
    expect(current.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);

    for (const path of ["/site/favicon?v=1600", "/site/favicon?v=", "/site/favicon"]) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("cache-control"), path).toBe("no-cache");
      expect(response.headers.get("etag"), path).toBe("\"favicon-1\"");
    }

    const revalidated = await get("/site/favicon?v=1600", { "if-none-match": "\"favicon-1\"" });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("cache-control")).toBe("no-cache");
    expect(faviconCacheControl(null, "")).toBe("no-cache");
  });

  test("returns 404 when no favicon is set", async () => {
    const response = await app(() => null, noProfileImages)("/site/favicon");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "FAVICON_NOT_FOUND" });
  });
});

describe("GET /profile-images/:fileName", () => {
  test("streams exactly the uploaded bytes as an immutable resource", async () => {
    const store = await localStore();
    const logger = { warn: mock(() => undefined) } as unknown as Logger;
    const images = new ProfileImageService(store, logger, async () => undefined);
    const { image } = await images.upload(null, { buffer: PNG, mimetype: "image/png", size: PNG.byteLength }, new Headers());
    const path = image?.replace(/^\/api/, "") ?? "";
    const get = app(() => null, images);

    const response = await get(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(response.headers.get("content-length")).toBe(String(PNG.byteLength));
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);

    const revalidated = await get(path, { "if-none-match": response.headers.get("etag") ?? "" });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);

    await images.remove(image ?? null, new Headers());
    expect((await get(path)).status).toBe(404);
  });

  test("returns 404 for names that are not managed images", async () => {
    const store = await localStore();
    const logger = { warn: mock(() => undefined) } as unknown as Logger;
    const get = app(() => null, new ProfileImageService(store, logger, async () => undefined));

    for (const name of ["missing.png", "123e4567-e89b-42d3-a456-426614174000.png", "..%2Fsite%2Ffavicon"]) {
      expect((await get(`/profile-images/${name}`)).status).toBe(404);
    }
  });
});
