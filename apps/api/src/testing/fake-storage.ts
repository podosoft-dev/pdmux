import type { ObjectStore } from "../storage/object-store";

/**
 * In-memory object storage for unit tests, with counters.
 *
 * The counters are the point: "a re-sent commit detail must not be rewritten" is
 * only provable by counting writes, not by reading the result back.
 */
export class FakeStorage {
  readonly objects = new Map<string, string>();
  readonly puts: string[] = [];
  readonly deletes: string[] = [];

  async put(key: string, body: Buffer | string): Promise<void> {
    this.puts.push(key);
    this.objects.set(key, typeof body === "string" ? body : body.toString("utf8"));
  }

  async get(key: string): Promise<Buffer> {
    const value = this.objects.get(key);
    // Mirrors S3: a missing key throws rather than returning empty.
    if (value === undefined) throw new Error(`NoSuchKey: ${key}`);
    return Buffer.from(value, "utf8");
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.objects.delete(key);
  }

  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(key));
  }

  presignedGetUrl(key: string): Promise<string> {
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
