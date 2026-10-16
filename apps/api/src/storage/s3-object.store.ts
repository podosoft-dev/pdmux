import {
  assertPartNumber,
  normalizeCompletedParts,
  type CompletedPart,
  type CreateMultipartUploadOptions,
  type DownloadUrlOptions,
  type ListObjectsOptions,
  type MultipartUpload,
  type ObjectBody,
  type ObjectData,
  type ObjectInfo,
  type ObjectPage,
  type ObjectStore,
  type PutObjectOptions,
  type StoredObject,
  type UploadedPart,
} from "@podosoft/podokit-runtime";
import type { StorageService } from "./storage.service";

const MAX_KEY_BYTES = 1024;

/**
 * Checks a key for writing. S3 limits keys to 1024 bytes, and a "." or ".."
 * segment would be resolved away in the request URL, writing another key.
 */
export function s3ObjectKey(key: string): string {
  if (key.length === 0 || Buffer.byteLength(key) > MAX_KEY_BYTES) {
    throw new Error(`Object key must be 1 to ${MAX_KEY_BYTES} bytes`);
  }
  if (key.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("Object key must not contain . or .. segments");
  }
  return key;
}

export class S3ObjectStore implements ObjectStore {
  constructor(private readonly storage: StorageService) {}

  async put(key: string, body: ObjectBody, options: PutObjectOptions = {}): Promise<StoredObject> {
    const objectKey = s3ObjectKey(key);
    const size = await this.storage.put(objectKey, body, options.contentType);
    return { key: objectKey, size, ...options };
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

  async createMultipartUpload(key: string, options: CreateMultipartUploadOptions = {}): Promise<MultipartUpload> {
    return { uploadId: await this.storage.createMultipartUpload(s3ObjectKey(key), options.contentType) };
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, body: ObjectBody): Promise<UploadedPart> {
    const objectKey = s3ObjectKey(key);
    assertPartNumber(partNumber);
    return this.storage.uploadPart(objectKey, uploadId, partNumber, body);
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: readonly CompletedPart[]): Promise<ObjectInfo> {
    const objectKey = s3ObjectKey(key);
    await this.storage.completeMultipartUpload(objectKey, uploadId, normalizeCompletedParts(parts));
    const info = await this.storage.stat(objectKey);
    if (!info) throw new Error(`Object ${objectKey} was removed right after its upload completed`);
    return info;
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.storage.abortMultipartUpload(s3ObjectKey(key), uploadId);
  }

  close(): void {}
}
