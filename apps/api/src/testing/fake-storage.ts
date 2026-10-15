import type {
  ObjectBody,
  ObjectData,
  ObjectInfo,
  ObjectPage,
  ObjectStore,
  PutObjectOptions,
  StoredObject,
} from "@podosoft/podokit-runtime";

async function text(body: ObjectBody): Promise<string> {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * In-memory object storage for unit tests, with counters.
 *
 * The counters are the point: "a re-sent commit detail must not be rewritten" is
 * only provable by counting writes, not by reading the result back.
 */
export class FakeStorage implements ObjectStore {
  readonly objects = new Map<string, string>();
  readonly puts: string[] = [];
  readonly deletes: string[] = [];

  async put(key: string, body: ObjectBody, options: PutObjectOptions = {}): Promise<StoredObject> {
    this.puts.push(key);
    const value = await text(body);
    this.objects.set(key, value);
    return { key, size: Buffer.byteLength(value), ...(options.contentType ? { contentType: options.contentType } : {}) };
  }

  async get(key: string): Promise<ObjectData | null> {
    const info = await this.stat(key);
    const value = this.objects.get(key);
    if (!info || value === undefined) return null;
    return { ...info, body: new Response(value).body ?? new ReadableStream() };
  }

  stat(key: string): Promise<ObjectInfo | null> {
    const value = this.objects.get(key);
    if (value === undefined) return Promise.resolve(null);
    return Promise.resolve({
      key,
      size: Buffer.byteLength(value),
      etag: `"${Bun.hash(value).toString(16)}"`,
      lastModified: new Date(0),
    });
  }

  list(prefix: string): Promise<ObjectPage> {
    return Promise.resolve({ keys: [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort() });
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.objects.delete(key);
  }

  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(key));
  }

  getDownloadUrl(key: string): Promise<string> {
    return Promise.resolve(`/storage/${encodeURIComponent(key)}`);
  }

  close(): void {}

  putCount(key: string): number {
    return this.puts.filter((candidate) => candidate === key).length;
  }

  asStorage(): ObjectStore {
    return this;
  }
}
