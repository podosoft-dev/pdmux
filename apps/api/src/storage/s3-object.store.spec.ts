import { afterAll, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { ReadinessService } from "../health/readiness.service";
import { S3ObjectStore } from "./s3-object.store";
import { StorageService } from "./storage.service";

// Runs against the bucket in the S3_* settings, like the storage API spec.
const integration = process.env.S3_ENDPOINT ? describe : describe.skip;

integration("S3ObjectStore against a live bucket", () => {
  const storage = new StorageService(new ReadinessService());
  const store = new S3ObjectStore(storage);
  const prefix = `podokit-test/${randomUUID()}/`;
  const created: string[] = [];

  async function put(name: string, content: Uint8Array | string, contentType?: string): Promise<string> {
    const key = `${prefix}${name}`;
    created.push(key);
    await store.put(key, content, contentType ? { contentType } : {});
    return key;
  }

  afterAll(async () => {
    await Promise.all(created.map((key) => storage.delete(key)));
    storage.close();
  });

  it("describes an object and streams exactly its content", async () => {
    const content = randomBytes(3 * 1024 * 1024);
    const key = await put("object.bin", content, "application/octet-stream");

    const info = await store.stat(key);
    expect(info).toMatchObject({ key, size: content.byteLength, contentType: "application/octet-stream" });
    expect(info?.etag).toMatch(/^"[^"]+"$/);
    expect(info?.lastModified).toBeInstanceOf(Date);

    const object = await store.get(key);
    if (!object) throw new Error("expected the stored object");
    expect(object.etag).toBe(info?.etag ?? "");
    const streamed = Buffer.from(await new Response(object.body).arrayBuffer());
    expect(streamed.equals(content)).toBe(true);
  });

  it("lists keys a page at a time", async () => {
    const names = ["list/a.txt", "list/b.txt", "list/c/d.txt", "list/e.txt", "listed.txt"];
    for (const name of names) await put(name, name);

    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await store.list(`${prefix}list/`, { limit: 2, ...(cursor ? { cursor } : {}) });
      pages.push(page.keys.map((key) => key.slice(prefix.length)));
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    expect(pages).toEqual([["list/a.txt", "list/b.txt"], ["list/c/d.txt", "list/e.txt"]]);
    expect((await store.list(`${prefix}list`)).keys).toHaveLength(names.length);
    await expect(store.list(prefix, { limit: 0 })).rejects.toThrow("from 1 to 1000");
  });

  it("reports a missing key as null and lets an unread body be dropped", async () => {
    expect(await store.get(`${prefix}missing`)).toBeNull();
    expect(await store.stat(`${prefix}missing`)).toBeNull();

    const key = await put("unread.txt", "unread", "text/plain");
    const object = await store.get(key);
    if (!object) throw new Error("expected the stored object");
    await object.body.cancel();
    expect(object.size).toBe(6);
  });

  it("fails the stream rather than mix in content written after the metadata was read", async () => {
    const key = await put("replaced.txt", "before", "text/plain");
    const object = await store.get(key);
    if (!object) throw new Error("expected the stored object");
    await store.put(key, "after!", { contentType: "text/plain" });

    await expect(new Response(object.body).text()).rejects.toThrow("changed while it was being read");
  });
});
