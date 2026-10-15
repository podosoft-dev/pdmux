import { Elysia, t } from "elysia";
import { OBJECT_STORAGE, objectResponse } from "@podosoft/podokit-runtime";
import { PROVIDERS } from "../config/providers";
import {
  type AppPlugin,
  type ElysiaPlugin,
  type PodokitModule,
  READINESS,
  REQUEST_IDENTITY,
  type RequestIdentity,
  type ServiceKey,
} from "../core/services";
import { StorageService } from "./storage.service";
import { S3ObjectStore } from "./s3-object.store";
import {
  demoKeyParams,
  demoObjectKey,
  storageObjectNotFound,
  requireStorageAdmin,
} from "./storage-demo";

export const STORAGE = Symbol("storage") as ServiceKey<StorageService>;

export type DemoStorage = Pick<StorageService, "put" | "open" | "presignedGetUrl">;

export function storageDemoRoutes(storage: DemoStorage, identity: RequestIdentity): ElysiaPlugin {
  return new Elysia({ name: "podokit.storage" })
    .put("/storage/:key", async ({ request, params, body }) => {
      await requireStorageAdmin(identity, request);
      await storage.put(demoObjectKey(params.key), body.content, "text/plain");
      return { key: params.key };
    }, {
      params: demoKeyParams,
      body: t.Object({ content: t.String() }),
      detail: { tags: ["storage"], summary: "Store a demo object (administrators only)" },
    })
    .get("/storage/:key/presigned", async ({ request, params }) => {
      await requireStorageAdmin(identity, request);
      return { url: await storage.presignedGetUrl(demoObjectKey(params.key)) };
    }, {
      params: demoKeyParams,
      detail: { tags: ["storage"], summary: "Presign a demo object download (administrators only)" },
    })
    .get("/storage/:key", async ({ request, params }) => {
      await requireStorageAdmin(identity, request);
      const object = await storage.open(demoObjectKey(params.key));
      if (!object) throw storageObjectNotFound();
      return objectResponse(request, object, { headers: { "x-content-type-options": "nosniff" } });
    }, {
      params: demoKeyParams,
      detail: { tags: ["storage"], summary: "Read a demo object (administrators only)" },
    });
}

const storagePlugin: AppPlugin = ({ services }) => {
  if (PROVIDERS["object-storage"] !== "s3") {
    return new Elysia({ name: "podokit.storage-s3.inactive" });
  }
  return storageDemoRoutes(services.resolve(STORAGE), services.resolve(REQUEST_IDENTITY));
};

export const storageModule: PodokitModule = {
  name: "object-storage-s3",
  configure: (_env, services): void => {
    if (PROVIDERS["object-storage"] !== "s3") return;
    const storage = new StorageService(services.resolve(READINESS));
    services.register(STORAGE, storage, () => storage.close());
    services.register(OBJECT_STORAGE, new S3ObjectStore(storage));
  },
  plugin: storagePlugin,
};
