import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  CompletedPart,
  CreateMultipartUploadOptions,
  DownloadUrlOptions,
  ListObjectsOptions,
  MultipartUpload,
  ObjectBody,
  ObjectData,
  ObjectInfo,
  ObjectPage,
  ObjectStore,
  PutObjectOptions,
  StoredObject,
  UploadedPart,
} from "@podosoft/podokit-runtime";

const KEY_BYTES = 32;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const MAX_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;
const EXPIRES = /^\d{1,12}$/;

export interface DownloadUrlSignature {
  expires: string;
  signature: string;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function readKey(path: string): Promise<Buffer> {
  const key = await readFile(path);
  if (key.byteLength !== KEY_BYTES) throw new Error(`Download URL key is corrupt: ${path}`);
  return key;
}

/**
 * Creates the key once and shares it with every later process. `link` fails
 * when another process won the race, so a reader never sees a partial file.
 */
async function loadOrCreateKey(path: string): Promise<Buffer> {
  try {
    return await readKey(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, randomBytes(KEY_BYTES), { mode: 0o600, flag: "wx" });
  try {
    await link(temporary, path);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  return readKey(path);
}

/**
 * Signs local download URLs so a URL works like an S3 presigned URL: it names
 * one object, expires, and cannot be altered to reach another key.
 */
export class DownloadUrlSigner {
  private key?: Promise<Buffer>;

  constructor(
    private readonly keyFile: string,
    private readonly now: () => number = Date.now,
  ) {}

  async sign(
    objectKey: string,
    expiresInSeconds = DEFAULT_EXPIRES_IN_SECONDS,
  ): Promise<DownloadUrlSignature> {
    const lifetime = Math.min(
      Math.max(Math.floor(expiresInSeconds), 1),
      MAX_EXPIRES_IN_SECONDS,
    );
    const expires = String(Math.floor(this.now() / 1000) + lifetime);
    const signature = (await this.digest(objectKey, expires)).toString("base64url");
    return { expires, signature };
  }

  async verify(
    objectKey: string,
    expires: string | undefined,
    signature: string | undefined,
  ): Promise<boolean> {
    if (!expires || !signature || !EXPIRES.test(expires)) return false;
    if (Number(expires) * 1000 <= this.now()) return false;
    const expected = await this.digest(objectKey, expires);
    const provided = Buffer.from(signature, "base64url");
    return provided.byteLength === expected.byteLength && timingSafeEqual(provided, expected);
  }

  private async digest(objectKey: string, expires: string): Promise<Buffer> {
    this.key ??= loadOrCreateKey(this.keyFile);
    return createHmac("sha256", await this.key)
      .update(`podokit-local-download-v1\n${expires}\n${objectKey}`, "utf8")
      .digest();
  }
}

/** Reverses the per-segment encoding used in download URL paths. */
export function objectKeyFromPath(encoded: string): string | undefined {
  try {
    return encoded.split("/").map((segment) => decodeURIComponent(segment)).join("/");
  } catch {
    return undefined;
  }
}

/** Delegates storage to the local store and adds a signature to download URLs. */
export class SignedDownloadStore implements ObjectStore {
  constructor(
    private readonly store: ObjectStore,
    private readonly signer: DownloadUrlSigner,
    private readonly baseUrl: string,
  ) {}

  put(key: string, body: ObjectBody, options?: PutObjectOptions): Promise<StoredObject> {
    return this.store.put(key, body, options);
  }

  get(key: string): Promise<ObjectData | null> {
    return this.store.get(key);
  }

  stat(key: string): Promise<ObjectInfo | null> {
    return this.store.stat(key);
  }

  list(prefix: string, options?: ListObjectsOptions): Promise<ObjectPage> {
    return this.store.list(prefix, options);
  }

  exists(key: string): Promise<boolean> {
    return this.store.exists(key);
  }

  delete(key: string): Promise<void> {
    return this.store.delete(key);
  }

  async getDownloadUrl(key: string, options: DownloadUrlOptions = {}): Promise<string> {
    const path = await this.store.getDownloadUrl(key);
    const prefix = `${this.baseUrl}/`;
    const objectKey = path.startsWith(prefix) ? objectKeyFromPath(path.slice(prefix.length)) : undefined;
    if (objectKey === undefined) throw new Error("Local download URL does not match its base URL");
    const { expires, signature } = await this.signer.sign(objectKey, options.expiresInSeconds);
    return `${path}?${new URLSearchParams({ expires, signature }).toString()}`;
  }

  createMultipartUpload(key: string, options?: CreateMultipartUploadOptions): Promise<MultipartUpload> {
    return this.store.createMultipartUpload(key, options);
  }

  uploadPart(key: string, uploadId: string, partNumber: number, body: ObjectBody): Promise<UploadedPart> {
    return this.store.uploadPart(key, uploadId, partNumber, body);
  }

  completeMultipartUpload(key: string, uploadId: string, parts: readonly CompletedPart[]): Promise<ObjectInfo> {
    return this.store.completeMultipartUpload(key, uploadId, parts);
  }

  abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    return this.store.abortMultipartUpload(key, uploadId);
  }

  close(): void | Promise<void> {
    return this.store.close();
  }
}
