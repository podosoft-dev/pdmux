import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { ObjectData, ObjectStore } from "@podosoft/podokit-runtime";
import { SiteSettingsService } from "./site-settings.service";

const favicon: ObjectData = {
  key: "site/favicon",
  size: 1,
  etag: "\"icon\"",
  lastModified: new Date(0),
  body: new ReadableStream<Uint8Array>(),
};
const storage = {
  put: async (): Promise<void> => undefined,
  get: async (key: string): Promise<ObjectData | null> => (key === "site/favicon" ? favicon : null),
} as unknown as ObjectStore;

interface Harness {
  service: SiteSettingsService;
  reads: () => number;
  holdNextRead: () => () => void;
  advance: (milliseconds: number) => void;
  failNextWrite: () => void;
}

describe("SiteSettingsService", () => {
  let db: SQL;
  let harness: Harness;

  beforeEach(async () => {
    db = new SQL(":memory:");
    await db`CREATE TABLE "app_setting" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL, "updatedAt" TEXT)`;
    await db`INSERT INTO "app_setting" ("key", "value") VALUES ('site.name', 'Before'), ('require2fa', 'false')`;

    let reads = 0;
    let clock = 1_000;
    let hold: Promise<void> | null = null;
    let failWrite = false;
    // Counts reads and can hold a read's result to interleave it with a write.
    const counted = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> => {
      reads += 1;
      const gate = hold;
      hold = null;
      const rows: unknown = await db(strings, ...values);
      if (gate) await gate;
      return rows;
    };
    const sql = Object.assign(counted, {
      begin: <T>(work: (tx: SQL) => Promise<T>): Promise<T> =>
        db.begin(async (tx) => {
          const result = await work(tx as unknown as SQL);
          if (failWrite) {
            failWrite = false;
            throw new Error("write failed");
          }
          return result;
        }),
    });
    harness = {
      service: new SiteSettingsService(sql as unknown as SQL, storage, () => clock),
      reads: () => reads,
      holdNextRead: () => {
        let release: () => void = () => undefined;
        hold = new Promise((resolve) => { release = resolve; });
        return release;
      },
      advance: (milliseconds) => { clock += milliseconds; },
      failNextWrite: () => { failWrite = true; },
    };
  });

  afterEach(async () => {
    await db.close();
  });

  test("serves concurrent and repeated reads from one query", async () => {
    const results = await Promise.all([
      harness.service.getAll(),
      harness.service.getAll(),
      harness.service.get("name"),
      harness.service.faviconVersion(),
    ]);
    await harness.service.getAll();

    expect(harness.reads()).toBe(1);
    expect(results[0]).toEqual({ name: "Before" });
    expect(results[2]).toBe("Before");
    expect(results[3]).toBeNull();
  });

  test("reads again after the snapshot expires", async () => {
    await harness.service.getAll();
    harness.advance(2_999);
    await harness.service.getAll();
    expect(harness.reads()).toBe(1);

    harness.advance(1);
    await harness.service.getAll();
    expect(harness.reads()).toBe(2);
  });

  test("returns a write to the next read immediately", async () => {
    await harness.service.getAll();

    const saved = await harness.service.setMany({ name: "After", locale: "ko" });

    expect(saved).toEqual({ name: "After", locale: "ko" });
    expect(await harness.service.getAll()).toEqual({ name: "After", locale: "ko" });
  });

  test("writes every key in one transaction", async () => {
    harness.failNextWrite();

    await expect(harness.service.setMany({ name: "After", locale: "ko" })).rejects.toThrow("write failed");

    expect(await harness.service.getAll()).toEqual({ name: "Before" });
  });

  test("does not keep a read that raced a write", async () => {
    const release = harness.holdNextRead();
    const stale = harness.service.getAll();

    await harness.service.setMany({ name: "After" });
    release();

    expect(await stale).toEqual({ name: "Before" });
    expect(await harness.service.getAll()).toEqual({ name: "After" });
  });

  test("derives the favicon fields from the same snapshot", async () => {
    await harness.service.setFavicon(new Uint8Array([1]), "image/png");
    const reads = harness.reads();

    const all = await harness.service.getAll();

    expect(all.faviconContentType).toBe("image/png");
    expect(await harness.service.faviconVersion()).toBe(all.faviconUpdatedAt ?? "missing");
    expect(harness.reads()).toBe(reads);
  });

  test("returns the favicon unread with its type and version from the snapshot", async () => {
    expect(await harness.service.getFavicon()).toBeNull();
    await harness.service.setFavicon(new Uint8Array([1]), "image/png");
    const reads = harness.reads();
    const version = await harness.service.faviconVersion();

    expect(await harness.service.getFavicon()).toEqual({ object: favicon, contentType: "image/png", version });
    expect(version).toMatch(/^\d+$/);
    expect(harness.reads()).toBe(reads);
  });

  test("copies the snapshot for each caller", async () => {
    const first = await harness.service.getAll();
    first.name = "Changed";

    expect(await harness.service.getAll()).toEqual({ name: "Before" });
  });
});
