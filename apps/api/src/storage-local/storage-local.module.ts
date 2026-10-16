import { AppException } from "@podosoft/podokit-contracts";
import {
  LocalObjectStore,
  OBJECT_STORAGE,
  objectResponse,
  type ObjectData,
  type ObjectStore,
} from "@podosoft/podokit-runtime";
import { Elysia, t } from "elysia";
import { join, resolve } from "node:path";
import {
  ACCESS_POLICY,
  REQUEST_IDENTITY,
  type AppPlugin,
  type ElysiaPlugin,
  type PodokitModule,
  type RequestIdentity,
  type ServiceKey,
} from "../core/services";
import { PROVIDERS } from "../config/providers";
import { DownloadUrlSigner, objectKeyFromPath, SignedDownloadStore } from "./download-url";
import {
  demoKeyParams,
  demoObjectKey,
  requireStorageAdmin,
  storageObjectNotFound,
} from "./storage-demo";

export const DOWNLOAD_BASE_URL = "/files/content";
const DEFAULT_MULTIPART_MAX_AGE_SECONDS = 24 * 60 * 60;

/** How long an unfinished multipart upload may sit idle before its parts are removed. */
export function multipartMaxAgeMs(value = process.env.LOCAL_STORAGE_MULTIPART_MAX_AGE): number {
  if (value === undefined || value.trim() === "") return DEFAULT_MULTIPART_MAX_AGE_SECONDS * 1000;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new Error("LOCAL_STORAGE_MULTIPART_MAX_AGE must be a positive integer of seconds");
  }
  return seconds * 1000;
}
export const LOCAL_DOWNLOAD_URLS = Symbol("local-download-urls") as ServiceKey<DownloadUrlSigner>;

async function readObject(storage: ObjectStore, key: string): Promise<ObjectData> {
  const object = await storage.get(key);
  if (!object) throw storageObjectNotFound();
  return object;
}

// Local objects are served from the app's own origin with the type the uploader
// declared. Only render types that cannot run script; everything else downloads,
// and the sandbox policy blocks script even if a browser renders it anyway.
const INLINE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "text/plain",
]);

export function downloadSafetyHeaders(contentType: string | undefined): Record<string, string> {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return {
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "content-disposition": INLINE_CONTENT_TYPES.has(mediaType) ? "inline" : "attachment",
  };
}

export function localStorageRoutes(
  storage: ObjectStore,
  signer: DownloadUrlSigner,
  identity: RequestIdentity,
): ElysiaPlugin {
  return new Elysia({ name: "podokit.storage-local" })
    .get("/files/content/*", async ({ request, params, query }) => {
      const key = objectKeyFromPath(params["*"]);
      if (key === undefined || !(await signer.verify(key, query.expires, query.signature))) {
        throw new AppException(
          "DOWNLOAD_URL_INVALID",
          "The download URL is invalid or has expired",
          403,
        );
      }
      const object = await readObject(storage, key);
      return objectResponse(request, object, { headers: downloadSafetyHeaders(object.contentType) });
    }, {
      query: t.Object({
        expires: t.Optional(t.String()),
        signature: t.Optional(t.String()),
      }),
      detail: { tags: ["files"], summary: "Read a local object through a signed download URL" },
    })
    .put("/storage/:key", async ({ request, params, body }) => {
      await requireStorageAdmin(identity, request);
      await storage.put(demoObjectKey(params.key), body.content, { contentType: "text/plain" });
      return { key: params.key };
    }, {
      params: demoKeyParams,
      body: t.Object({ content: t.String() }),
      detail: { tags: ["storage"], summary: "Store a demo object (administrators only)" },
    })
    .get("/storage/:key/presigned", async ({ request, params }) => {
      await requireStorageAdmin(identity, request);
      return { url: await storage.getDownloadUrl(demoObjectKey(params.key)) };
    }, {
      params: demoKeyParams,
      detail: { tags: ["storage"], summary: "Sign a demo object download URL (administrators only)" },
    })
    .get("/storage/:key", async ({ request, params }) => {
      await requireStorageAdmin(identity, request);
      const object = await readObject(storage, demoObjectKey(params.key));
      return objectResponse(request, object, { headers: downloadSafetyHeaders(object.contentType) });
    }, {
      params: demoKeyParams,
      detail: { tags: ["storage"], summary: "Read a demo object (administrators only)" },
    });
}

const localStoragePlugin: AppPlugin = ({ services }) => {
  if (PROVIDERS["object-storage"] !== "local") {
    return new Elysia({ name: "podokit.storage-local.inactive" });
  }
  return localStorageRoutes(
    services.resolve(OBJECT_STORAGE),
    services.resolve(LOCAL_DOWNLOAD_URLS),
    services.resolve(REQUEST_IDENTITY),
  );
};

export const storageLocalModule: PodokitModule = {
  name: "object-storage-local",
  configure: (_env, services): void => {
    if (PROVIDERS["object-storage"] !== "local") return;
    const root = resolve(process.env.LOCAL_STORAGE_PATH ?? "./data/files");
    const signer = new DownloadUrlSigner(join(root, ".podokit", "download-url.key"));
    const storage = new SignedDownloadStore(
      new LocalObjectStore({
        rootDirectory: root,
        publicBaseUrl: DOWNLOAD_BASE_URL,
        multipartMaxAgeMs: multipartMaxAgeMs(),
      }),
      signer,
      DOWNLOAD_BASE_URL,
    );
    services.register(OBJECT_STORAGE, storage, () => storage.close());
    services.register(LOCAL_DOWNLOAD_URLS, signer);
    // The signature is the authorization, as with an S3 presigned URL.
    services.resolve(ACCESS_POLICY).register("GET", `${DOWNLOAD_BASE_URL}/*`, "public");
  },
  plugin: localStoragePlugin,
};
