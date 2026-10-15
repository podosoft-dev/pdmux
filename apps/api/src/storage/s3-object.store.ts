import type {
  DownloadUrlOptions,
  ListObjectsOptions,
  ObjectBody,
  ObjectData,
  ObjectInfo,
  ObjectPage,
  ObjectStore,
  PutObjectOptions,
  StoredObject,
} from "@podosoft/podokit-runtime";
import type { StorageService } from "./storage.service";

async function bodyBytes(body: ObjectBody): Promise<Uint8Array> {
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export class S3ObjectStore implements ObjectStore {
  constructor(private readonly storage: StorageService) {}

  async put(key: string, body: ObjectBody, options: PutObjectOptions = {}): Promise<StoredObject> {
    const bytes = await bodyBytes(body);
    await this.storage.put(key, bytes, options.contentType);
    return { key, size: bytes.byteLength, ...options };
  }

  get(key: string): Promise<ObjectData | null> {
    return this.storage.open(key);
  }

  stat(key: string): Promise<ObjectInfo | null> {
    return this.storage.stat(key);
  }

  list(prefix: string, options?: ListObjectsOptions): Promise<ObjectPage> {
    return this.storage.list(prefix, options);
  }

  exists(key: string): Promise<boolean> {
    return this.storage.exists(key);
  }

  delete(key: string): Promise<void> {
    return this.storage.delete(key);
  }

  getDownloadUrl(key: string, options: DownloadUrlOptions = {}): Promise<string> {
    return this.storage.presignedGetUrl(key, options.expiresInSeconds);
  }

  close(): void {}
}
