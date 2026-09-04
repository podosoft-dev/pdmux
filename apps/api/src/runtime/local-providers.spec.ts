import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalObjectStore } from "../storage/local-object.store";
import { MemoryCacheStore } from "./cache";
import { LocalJobProvider } from "./jobs";

let temporaryDirectory: string | undefined;

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe("[TC-PDDESKTOP-003] embedded runtime providers", () => {
  it("expires cache values and increments a fixed window", async () => {
    const cache = new MemoryCacheStore(2);
    await cache.set("value", "one", 1);
    expect(await cache.get("value")).toBe("one");
    expect((await cache.incrementFixedWindow("limit", 10)).count).toBe(1);
    expect((await cache.incrementFixedWindow("limit", 10)).count).toBe(2);
    cache.close();
  });

  it("stores local objects atomically and rejects traversal", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pdmux-storage-"));
    const storage = new LocalObjectStore(temporaryDirectory);
    await storage.put("git/detail.json", '{"ok":true}');
    expect((await storage.get("git/detail.json")).toString("utf8")).toBe('{"ok":true}');
    expect(await storage.exists("git/detail.json")).toBe(true);
    await expect(storage.put("../escape", "no")).rejects.toThrow("safe relative path");
  });

  it("executes local jobs in-process and retains their result", async () => {
    const jobs = new LocalJobProvider();
    jobs.register("demo", "uppercase", ({ data }) => String(data.text).toUpperCase());
    const created = await jobs.enqueue("demo", "uppercase", { text: "desktop" });
    await Bun.sleep(5);
    const completed = await jobs.get("demo", created.id);
    expect(completed).toEqual({ id: created.id, state: "completed", result: "DESKTOP" });
    await jobs.close();
  });
});
