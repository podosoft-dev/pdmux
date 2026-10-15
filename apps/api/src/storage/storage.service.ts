import { S3Client, type S3Stats } from "bun";
import {
  objectListLimit,
  type ListObjectsOptions,
  type ObjectData,
  type ObjectInfo,
  type ObjectPage,
} from "@podosoft/podokit-runtime";
import { ReadinessService } from "../health/readiness.service";
import { storageSettings } from "./storage.config";

function isMissingObject(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "NoSuchKey";
}

function entityTag(etag: string): string {
  return etag.startsWith("\"") || etag.startsWith("W/\"") ? etag : `"${etag}"`;
}

function objectInfo(key: string, stats: S3Stats): ObjectInfo {
  return {
    key,
    size: stats.size,
    ...(stats.type ? { contentType: stats.type } : {}),
    etag: entityTag(stats.etag),
    lastModified: stats.lastModified,
  };
}

/**
 * Downloads on the first read, so an unread body costs no request. Bun's
 * `S3File.stream()` reads ahead without backpressure and would hold the rest of
 * the object for a slow client; a presigned GET through fetch is paced by the
 * socket instead, and If-Match keeps it on the version that was described.
 */
function download(client: S3Client, key: string, etag: string): ReadableStream<Uint8Array> {
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      if (!reader) {
        const response = await fetch(client.presign(key, { expiresIn: 60 }), {
          headers: { "if-match": etag },
          decompress: false,
          signal: abort.signal,
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error(
            response.status === 404 || response.status === 412
              ? `Object ${key} changed while it was being read`
              : `Object ${key} download failed with status ${response.status}`,
          );
        }
        reader = response.body.getReader();
      }
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason): Promise<void> {
      abort.abort(reason);
      await reader?.cancel(reason).catch(() => undefined);
    },
  }, { highWaterMark: 0 });
}

export class StorageService {
  private readonly client: S3Client;
  private unregisterReadiness?: () => void;

  constructor(readiness: ReadinessService) {
    const settings = storageSettings();
    this.client = new S3Client({
      bucket: settings.bucket,
      region: settings.region,
      virtualHostedStyle: settings.virtualHostedStyle,
      ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
      ...(settings.accessKeyId ? { accessKeyId: settings.accessKeyId } : {}),
      ...(settings.secretAccessKey ? { secretAccessKey: settings.secretAccessKey } : {}),
    });
    this.unregisterReadiness = readiness.register("object-storage", async () => {
      await this.client.exists(".podokit-readiness");
    });
  }

  async put(key: string, body: Uint8Array | string | Blob, contentType?: string): Promise<void> {
    await this.client.file(key).write(body, contentType ? { type: contentType } : undefined);
  }

  /** Reads a whole object into memory. Use `open()` for anything that can be large. */
  async get(key: string): Promise<Buffer> {
    const bytes = await this.client.file(key).bytes();
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Object metadata, or null when the key does not exist. */
  async stat(key: string): Promise<ObjectInfo | null> {
    try {
      return objectInfo(key, await this.client.file(key).stat());
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  /**
   * Metadata plus a streamed body, or null when the key does not exist. The
   * metadata request comes first because a missing key would otherwise only
   * fail the stream, after a response has already started.
   */
  async open(key: string): Promise<ObjectData | null> {
    const info = await this.stat(key);
    if (!info) return null;
    return { ...info, body: download(this.client, key, info.etag) };
  }

  /** One page of the keys under `prefix`; the bucket is never listed in full. */
  async list(prefix: string, options: ListObjectsOptions = {}): Promise<ObjectPage> {
    const page = await this.client.list({
      prefix,
      maxKeys: objectListLimit(options),
      ...(options.cursor ? { continuationToken: options.cursor } : {}),
    });
    const keys = (page.contents ?? []).map((object) => object.key);
    return page.isTruncated && page.nextContinuationToken
      ? { keys, nextCursor: page.nextContinuationToken }
      : { keys };
  }

  async exists(key: string): Promise<boolean> {
    return this.client.exists(key);
  }

  presignedGetUrl(key: string, expiresIn = 3600): Promise<string> {
    return Promise.resolve(this.client.presign(key, { expiresIn }));
  }

  async delete(key: string): Promise<void> {
    await this.client.delete(key);
  }

  close(): void {
    this.unregisterReadiness?.();
  }
}
