import { afterEach, describe, expect, it } from "bun:test";
import { storageSettings } from "./storage.config";

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
});

describe("storageSettings", () => {
  it("uses path-style MinIO settings by default", () => {
    process.env.STORAGE_PROVIDER = "minio";
    process.env.S3_ENDPOINT = "http://localhost:9000";
    expect(storageSettings()).toMatchObject({
      provider: "minio",
      endpoint: "http://localhost:9000",
      virtualHostedStyle: false,
    });
  });
});
